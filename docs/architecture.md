# Architecture

Terse — the _why_, not a restatement of the code.

## Encryption forces in-memory search

`filename`, `transcriptions.text`, `ai_enhancements.summary`/`key_points`/
`action_items` are AES-256-GCM ciphertext at rest (`v1:iv:tag:ciphertext`,
hex). Postgres only ever holds ciphertext, so `LIKE`/full-text search in SQL
is impossible — there's nothing to index. Search therefore has to decrypt
and scan in-process. Don't build a Postgres FTS index or push search into
SQL, since the DB can never see plaintext.

### Why not an inverted index?

An inverted index (token → posting list) would make stage-1-style ranking
O(matching docs) instead of O(corpus), but it can't do substring matching —
only whole-token lookups after your own tokenizer has split the text. That
breaks German compounds: `wärme` has to match inside `Wärmepumpe` (one
token, no whitespace), and a stemmed/tokenized index would need a
compound-splitter to catch that, not just a smarter analyzer. The current
approach (`indexOf` over normalized, un-tokenized text) gets substring
matching for free. Building and keeping an index in sync would also mean
holding normalized transcript text in memory permanently — exactly what the
metadata/on-demand-transcript split below avoids. Revisit only if profiling
shows stage 2 itself (not the whole corpus) is the bottleneck at realistic K.

Measured numbers: [`docs/performance.md`](./performance.md).

## The store is split: cheap metadata vs. on-demand transcript text

`RecordingStore.get()` returns metadata only — title, summary, key points,
action items, dates, and per-transcript _descriptors_ (source, provider,
model, language, approximate character length) — never transcript text.
Metadata is cheap (short strings, a handful of KB per recording) and is
searched constantly, so it stays cached in memory for `CACHE_TTL_MS`, with
its normalized-for-search form (see below) precomputed at refresh time.

Transcript text is the expensive part — tens of KB per recording, most of
it never read on a given search — so it's fetched only on demand, via
`RecordingStore.getTranscripts(recordingIds)`: one batched, parameterized
query (`WHERE recording_id = ANY($1)`, still on the read-only pool) for
exactly the ids that need it, decrypted, and served from a small LRU (sized
by `transcriptCacheSize`, default ~50 recordings) so paging one recording's
transcript doesn't requery it on every call. Decrypted text still never
touches disk — only the LRU, in memory, same invariant as before.

## Incremental refresh: two phases, the IV as the change signal

`RecordingStore.refresh()` is two-phase, so an unchanged corpus costs a
small, flat transfer instead of re-transferring and re-decrypting every
recording every `CACHE_TTL_MS`.

**Phase 1** (`STAMP_QUERY`) computes a per-recording change stamp from `left()`
prefixes only -- never a full ciphertext column -- built from the IV segment
of each encrypted field (`filename`, `summary`, `key_points`,
`action_items`), plus `is_trash`/`deleted_at`/`updated_at` and the set of
transcript `(id, source)` pairs. The at-rest format (`v1:<iv>:<tag>:<ciphertext>`)
draws a random IV on every encryption, so _any_ re-encryption of a field --
whatever changed inside it -- necessarily changes its IV; comparing just
that segment is a correct, decrypt-free change signal. A prefix is enough:
`ivStampOf`/`jsonIvStampOf` (`crypto.ts`) never look past the IV's own
position, so a `left(column, IV_STAMP_PREFIX_LEN)` prefix and the full
column value give the identical stamp for the same row (a unit test asserts
this equivalence directly, since it's the one invariant the whole scheme
depends on -- phase 1 and phase 2 must never disagree about a row that
didn't change). `updated_at` alone can't do this job on its own: nothing
guarantees Riffado bumps `recordings.updated_at` when a child row's summary
or transcript changes, and `transcriptions`/`ai_enhancements` carry no
`updated_at` at all -- so it's included in the stamp as defense in depth,
never as the sole signal.

Comparing each stamp to the previous refresh's stamp for that id splits the
corpus into unchanged ids (reused **by reference** -- no decrypt, no
re-normalize) and new/changed ids.

**Phase 2** (`METADATA_QUERY`, always `WHERE r.id = ANY($1)`) fetches full
metadata -- title/summary/key points/action items/transcript descriptors,
and only now touches any ciphertext -- for exactly those changed/new ids,
and is skipped entirely (no query at all) when nothing changed. The very
first refresh (cold start, or right after `invalidate()`, which drops the
stamps too) has no previous stamp to compare against, so every id counts as
new and phase 2 fetches the whole corpus once -- functionally the old
single-query refresh, plus phase 1's cheap round trip.

A field that isn't the `v1:` shape (never encrypted, or a different jsonb
wrapper) has no IV a bare prefix can verify -- unlike a full value, a
prefix can't fall back to "compare the rest of the value too." Rather than
risk a false "unchanged," `ivStampOf`/`jsonIvStampOf` return a fresh marker
on every call for that shape, so the recording is always routed through
phase 2 and rebuilt -- a correctness-preserving fallback, not free, but
never wrong. This is a real cost only for rows actually written that way;
on this deployment `riffado-db`'s `key_points`/`action_items` are the
encrypted wrapper and `filename`/`summary` are `v1:` for every row (checked
directly), so it doesn't apply to any current recording -- it exists for
whatever shape a future migration or import path might produce, and the
integration suite keeps one test (`rec-active`, deliberately seeded with
plain jsonb) proving the fallback itself, not just asserting it in the
abstract.

Numbers: [`docs/performance.md`](./performance.md).

## `riffado_search` is two-stage

Stage 1 (`rankByCheapFields`) scores every recording's pre-normalized
title/summary/key-points/action-items (weights 5/4/4/4) — cheap, no
transcript I/O. Stage 2 (`finalizeSearch`) fetches transcripts (weight 1)
for a candidate set — normally the stage-1 top `K = min(max(limit * 3, 30),
200)`, or every date-filtered recording under `deep: true` — and merges the
scores.

This trades recall for the corpus no longer needing to live decrypted in
memory: a term that appears _only_ in one recording's transcript, and in no
title/summary/key point/action item anywhere, won't surface unless that
recording happens to fall in the top-K by cheap-field score (rare beyond a
small corpus) or `deep: true` is passed. `scope: "summary"` skips stage 2
entirely (no transcript fetch at all); `"transcript"` reports stage-2
matches only, over the stage-1 candidate set; `"all"` (default) merges both.
The tool's description and its own response text say this plainly when
`deep` is false, so a client can tell a no-hit result from a real absence.

## Read-only transaction as the write guard

The pg pool starts every session with `-c default_transaction_read_only=on`.
Postgres itself then rejects any `INSERT`/`UPDATE`/`DELETE` — the guarantee
lives at the database layer, not in application code, so a bug or a prompt
injection in a tool handler cannot mutate Riffado no matter what SQL it
tries to build (all queries are parameterized `SELECT`s regardless). A
dedicated role with only `SELECT` grants (see README) is recommended on top:
a session-level default can in principle be overridden within the session,
a missing grant cannot.

## OAuth wraps a static token

Claude's custom-connector UI only speaks OAuth 2.0 (dynamic client
registration, authorization code, PKCE) — it has no field for pasting a
static bearer token. `StaticTokenOAuthProvider` implements just enough of
OAuth 2.1 for that UI: the user proves knowledge of `HTTP_AUTH_TOKEN` on a
login page, and in exchange receives a normal OAuth access token used as
`Authorization: Bearer <token>` on every request after. The shared token
itself (as a raw bearer or the `x-mcp-token` header) still works directly,
for stdio-adjacent or scripted use.

Clients and tokens are persisted to `HTTP_OAUTH_STATE_FILE` so the
connector survives restarts. The file also carries an HMAC-SHA256
fingerprint of the shared token (keyed by the token, never the token
itself); if it is missing or doesn't match the current `HTTP_AUTH_TOKEN`,
everything in the file is discarded on load. Every OAuth grant descends from
someone knowing the shared token, so rotating that token has to revoke them
all — otherwise a leaked refresh token would outlive the secret it was
obtained with. Tokens are indexed, in memory and on disk, by their SHA-256
hash only, so the state file is a straight dump of the maps and a copy of
it can't be replayed; the file carries `version: 2`, and anything older
(tokens keyed by raw value) is discarded like a fingerprint mismatch, at
the cost of one re-login after the upgrade. Access tokens expire after 1
hour, refresh tokens after 90 days. Each refresh rotates the refresh
token, restarts that clock, and revokes the access token issued alongside
the old one (the refresh token records its pair), so a grant has at most
one live access token; a refresh may narrow scopes but not widen them.
Expired tokens are dropped on load, on refresh, and on every state write;
expired authorization codes whenever a new one is issued.

Dynamic client registration is open by spec, which makes two things
attacker-controlled: the redirect URI and the registry size. Redirect URIs
must be on `HTTP_OAUTH_ALLOWED_REDIRECT_HOSTS` (checked at registration and
again when persisted clients are loaded), because the SDK's `/authorize`
302s to whatever the client registered — otherwise the server is an open
redirect and a phishing page that looks like our own login. The registry
cap evicts only clients without a live grant: a client with one got there
through the shared token, while a fresh anonymous registration did not, so
a flood can only cycle through other anonymous registrations; when every
slot holds a grant, registration fails instead of evicting.

Rate limiting follows the same line. Failed authentications are counted per
IP (the limiter runs only on the 401 path, so long-lived SSE streams and
normal traffic never consume that budget) and a spent budget 429s the IP
up front. Authenticated traffic only gets a generous ceiling against a
leaked token or a runaway client hammering the database; `/health` is
never limited.

## Don't put an identity-aware proxy in front

If you expose this through Cloudflare Tunnel or an equivalent, do it **without**
Cloudflare Access or any comparable identity-aware proxy. Such a proxy
intercepts the request with its own OAuth challenge before the MCP OAuth flow
above ever runs: Claude's connector then authenticates against the proxy rather
than against this server, and the MCP authorization flow never completes. The
static-token-wrapped OAuth provider _is_ the access control for the route —
which is exactly why `HTTP_AUTH_TOKEN` has to be a real secret.
