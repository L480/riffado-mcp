# Architecture

Terse — the _why_, not a restatement of the code.

## Encryption forces in-memory search

`filename`, `transcriptions.text`, `ai_enhancements.summary`/`key_points`/
`action_items` are AES-256-GCM ciphertext at rest (`v1:iv:tag:ciphertext`,
hex). Postgres only ever holds ciphertext, so `LIKE`/full-text search in SQL
is impossible — there's nothing to index. The dataset is tiny, so
`RecordingStore` loads everything, decrypts it, caches it for
`CACHE_TTL_MS`, and `search.ts` searches the decrypted in-memory copy. This
is deliberate, not a stopgap: don't build a Postgres FTS index or push
search into SQL, since the DB can never see plaintext.

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
