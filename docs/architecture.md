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
store split in 0.1.0 was for. Revisit only if profiling shows stage 2 itself
(not the whole corpus) is the bottleneck at realistic K.

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
tries to build (all queries are parameterized `SELECT`s regardless).

## OAuth wraps a static token

Claude's custom-connector UI only speaks OAuth 2.0 (dynamic client
registration, authorization code, PKCE) — it has no field for pasting a
static bearer token. `StaticTokenOAuthProvider` implements just enough of
OAuth 2.1 for that UI: the user proves knowledge of `HTTP_AUTH_TOKEN` on a
login page, and in exchange receives a normal OAuth access token used as
`Authorization: Bearer <token>` on every request after. The shared token
itself (as a raw bearer or the `x-mcp-token` header) still works directly,
for stdio-adjacent or scripted use.

## Don't put an identity-aware proxy in front

If you expose this through Cloudflare Tunnel or an equivalent, do it **without**
Cloudflare Access or any comparable identity-aware proxy. Such a proxy
intercepts the request with its own OAuth challenge before the MCP OAuth flow
above ever runs: Claude's connector then authenticates against the proxy rather
than against this server, and the MCP authorization flow never completes. The
static-token-wrapped OAuth provider _is_ the access control for the route —
which is exactly why `HTTP_AUTH_TOKEN` has to be a real secret.
