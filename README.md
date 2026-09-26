# riffado-mcp

[![CI](https://github.com/L480/riffado-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/L480/riffado-mcp/actions/workflows/ci.yml)
[![Release](https://github.com/L480/riffado-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/L480/riffado-mcp/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

An MCP server for the [Riffado](https://riffado.com) voice-recording archive
(Plaud device → Riffado app): transcripts, AI summaries, key points, action
items. Strictly read-only. Talks to the Riffado Postgres database directly
(not the Riffado API), decrypts at-rest ciphertext in-process, and serves it
over MCP — stdio for Claude Code, Streamable HTTP + OAuth for Claude Web/iOS.

## Tools

| Tool                        | What it does                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `riffado_list_recordings`   | List recordings (newest first by default), with title, date, duration, transcript sources, optional summary snippet.                                                              |
| `riffado_search`            | Two-stage search over titles/summaries/key points/action items, then transcripts, in-process (the DB only holds ciphertext). `deep: true` widens transcript scanning — see below. |
| `riffado_get_recording`     | Full detail for one recording: metadata, summary, key points, action items, a pageable transcript slice (fetched on demand).                                                      |
| `riffado_list_action_items` | Flattened action items across recordings, each tagged with its source recording.                                                                                                  |
| `riffado_stats`             | Recording count, total/median duration, first/last date, transcripts per source/provider, coverage gaps.                                                                          |

### `riffado_search`: two-stage, and the `deep` parameter

Search runs in two stages. **Stage 1** scores the whole corpus against
pre-normalized titles/summaries/key points/action items only (cheap, always
in memory). **Stage 2** fetches and scans transcript text, but only for the
top-ranked stage-1 candidates (`K = min(max(limit * 3, 30), 200)`) — not the
whole corpus. `scope: "summary"` stops after stage 1 (no transcript fetch
at all); `scope: "all"` (default) and `scope: "transcript"` run stage 2 over
the candidate set.

This means a term that appears **only** in one recording's transcript, and
nowhere in any title/summary/key point/action item, may not surface unless
that recording happens to rank in the top-K by cheap-field score. Pass
**`deep: true`** to scan every recording's transcript that passes the
`from`/`to` date filter instead of just the candidates — slower, and its
cost scales with corpus size, so combine it with `from`/`to` when possible.
The tool's response says explicitly when results were narrowed this way
(i.e. whenever `deep` is `false`), so a client can tell a no-hit result from
a real absence rather than assume one.

`query` is capped at 500 characters.

Also: resource `riffado://index` (markdown index), resource template
`riffado://recording/{id}`, and prompt `riffado_ask` (carries the answering
rules — cite date+title, quote verbatim, transcript beats AI summary, flag
ASR misreads, never fill gaps from general knowledge).

## Example questions

Things you can ask Claude once the server is connected:

- "What did I record yesterday?"
- "What action items came out of my recordings this week?"
- "Give me the transcript of my last call with Sarah." (paged in slices for long recordings)
- "How many recordings do I have, and what's my average recording length?"
- "Which of my recordings don't have a transcript yet?"

More complex, research-style questions Claude can answer by combining
several tool calls (search → pull the matching recordings → read/quote
transcripts):

- "Across all my calls with customer Acme, what's the recurring technical
  pain point they keep bringing up?"
- "What does customer Acme's current tool stack look like, based on
  everything they've mentioned across our calls?"
- "When does Acme's contract expire, and did we discuss a renewal date in
  any recent call?"
- "Do a deep search (`deep: true`) through all transcripts for 'Meier
  contract' — this might not show up in summaries — and tell me what was
  agreed."
- "Compare what customer X and customer Y said about pricing across all
  our calls with them — where do their objections differ?"
- "Build a timeline of everything discussed with Acme this quarter, with
  dates and direct quotes."

## Environment variables

| Var                                 | Default                                          | Notes                                                                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                      | _required_                                       | `postgresql://postgres:…@riffado-db:5432/riffado`                                                                                                                                                                                                                    |
| `ENCRYPTION_KEY`                    | _required_                                       | 64 hex chars (32-byte AES key)                                                                                                                                                                                                                                       |
| `RIFFADO_USER_ID`                   | —                                                | restrict to one user                                                                                                                                                                                                                                                 |
| `RIFFADO_APP_URL`                   | —                                                | e.g. `https://riffado.example.com` → deep links in tool output                                                                                                                                                                                                       |
| `TRANSPORT`                         | `stdio`                                          | `stdio` \| `http`                                                                                                                                                                                                                                                    |
| `HTTP_PORT` / `HTTP_HOST`           | `3000` / `localhost`                             | port 1-65535; container sets host `0.0.0.0`                                                                                                                                                                                                                          |
| `HTTP_AUTH_TOKEN`                   | _required for `http`_                            | shared secret, min 32 chars; the HTTP transport refuses to start without it (unused on `stdio`)                                                                                                                                                                      |
| `HTTP_AUTH_HEADER_NAME`             | `x-mcp-token`                                    |                                                                                                                                                                                                                                                                      |
| `HTTP_OAUTH_ENABLED`                | `true`                                           | wraps `HTTP_AUTH_TOKEN` in an OAuth 2.1 login flow for Claude connectors                                                                                                                                                                                             |
| `HTTP_PUBLIC_URL`                   | —                                                | OAuth issuer; must be HTTPS unless `localhost`                                                                                                                                                                                                                       |
| `HTTP_OAUTH_STATE_FILE`             | `~/.riffado-mcp-oauth-state.json`                | container: `/app/data/oauth-state.json`                                                                                                                                                                                                                              |
| `HTTP_OAUTH_ALLOWED_REDIRECT_HOSTS` | `claude.ai,claude.com,localhost,127.0.0.1,[::1]` | comma-separated hostnames OAuth clients may register redirect URIs for (exact match, no port; `https` required except loopback, which may use `http`). Wildcards like `*` are **not** supported. Clients persisted with a host no longer listed are dropped on start |
| `HTTP_CORS_ORIGINS`                 | _(empty: no CORS)_                               | comma-separated browser origins allowed cross-origin access, e.g. `http://localhost:6274` for the MCP Inspector. Exact origins only (`scheme://host[:port]`, no path, no `*`). Claude's connector calls from Anthropic's servers and needs none                      |
| `HTTP_TRUST_PROXY`                  | `false`                                          | Express `trust proxy` (`true`/`false`, a hop count 0-10, or a subnet/preset); **set it (e.g. `1`) behind a reverse proxy / Cloudflare Tunnel**, leave it off when clients connect directly (otherwise `X-Forwarded-For` is spoofable)                                |
| `HTTP_SESSION_TIMEOUT_MS`           | `3600000` (1h)                                   | idle-session expiry; `0` = no idle expiry (explicit opt-out, sessions close only on DELETE/transport close); max 2147483647                                                                                                                                          |
| `CACHE_TTL_MS`                      | `60000`                                          | decrypted-store TTL; positive integer                                                                                                                                                                                                                                |
| `DB_STATEMENT_TIMEOUT_MS`           | `10000`                                          | passed to the pg pool; positive integer (`0` would mean no limit, so it is rejected)                                                                                                                                                                                 |

Numeric variables must be plain integers within their range — a value like
`3000abc` or `1.5` fails at startup instead of being silently truncated.

## Health checks

`GET /health` is the one route auth never gates — liveness only:
`{ status, timestamp }`. `GET /health/details` adds session count, DB
reachability and the cached recording count, and requires the same
auth as every other route (shared token or OAuth).

`/health` is also exempt from rate limiting. Everything else is limited per
client IP in 15-minute windows: 50 failed authentications (401s) lock that
IP out with `429` for the rest of the window, even with a valid token;
authenticated traffic is capped at 1000 requests; `/register`,
`/authorize` and `/token` together at 30.

## Quickstart: Claude Code (stdio)

```bash
npm install
npm run build
```

```json
{
  "mcpServers": {
    "riffado": {
      "command": "node",
      "args": ["/path/to/riffado-mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:...@riffado-db:5432/riffado",
        "ENCRYPTION_KEY": "..."
      }
    }
  }
}
```

## Quickstart: Claude Web / iOS (HTTP + OAuth)

1. Run the container with `TRANSPORT=http`, `HTTP_PUBLIC_URL` set to the
   public HTTPS URL, `HTTP_AUTH_TOKEN` set to a shared secret, and
   `HTTP_TRUST_PROXY=1` if it sits behind a reverse proxy or Cloudflare
   Tunnel.
2. In Claude, add a custom connector pointing at
   `https://riffado-mcp.example.com/mcp`.
3. Claude opens the login page, which names the host it will redirect to
   (for Claude, `claude.ai`); paste the `HTTP_AUTH_TOKEN` value. Claude
   then holds a normal OAuth bearer token — the connector survives process
   restarts because OAuth state is persisted to `HTTP_OAUTH_STATE_FILE`.
   Rotating `HTTP_AUTH_TOKEN` revokes every issued OAuth token and
   registered client on the next start; connectors then log in again with
   the new value. Access tokens live 1 hour and are refreshed silently;
   a connector left idle for more than 90 days (refresh token lifetime)
   has to log in again.

### Upgrade note: one-time re-login

The OAuth state file format changed (tokens are now stored only as
SHA-256 hashes, `version: 2`). On the first start after upgrading, the old
file is discarded and rewritten empty, so every connector has to log in
once more with `HTTP_AUTH_TOKEN`. Clients registered with a redirect host
outside `HTTP_OAUTH_ALLOWED_REDIRECT_HOSTS` are rejected from now on; if
you use an OAuth client other than Claude or a loopback tool, add its
callback host there.

## Docker Compose example

```yaml
services:
  riffado-mcp:
    image: ghcr.io/l480/riffado-mcp:latest
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    user: "7333:7333"
    environment:
      TZ: Europe/Berlin
      DATABASE_URL: postgresql://postgres:...@riffado-db:5432/riffado
      ENCRYPTION_KEY: "..."
      HTTP_PUBLIC_URL: https://riffado-mcp.example.com
      HTTP_AUTH_TOKEN: "..."
      # Behind a reverse proxy / Cloudflare Tunnel (one hop). Omit when
      # clients connect to the container directly.
      HTTP_TRUST_PROXY: "1"
    volumes:
      - /opt/riffado-mcp/data:/app/data
    networks: [root_default]
```

`/app/data` must be a writable volume — the image runs `--read-only`
otherwise, so it needs somewhere to persist `oauth-state.json` across
container recreation.

## Development

```bash
npm run lint          # eslint
npm run format:check  # prettier --check
npm run typecheck     # tsc --noEmit, src + test
npm test              # vitest, unit tests only
npm run build         # tsc -> dist/
```

Integration tests need a real Postgres:

```bash
docker compose -f docker-compose.test.yml up -d
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/riffado_test \
  npm run test:integration
docker compose -f docker-compose.test.yml down
```

## Performance

Search is two-stage: cheap fields (title/summary/key points/action items)
rank the whole corpus first, then only the top candidates get their
transcripts fetched and scanned — `deep: true` trades that speed for full
recall by scanning every date-filtered recording's transcript instead, and
is far slower by design. Headline number: a 3-term `scope: "all"` search at
20 000 recordings runs in ~175 ms (p50).

Full measured numbers and limitations: [`docs/performance.md`](./docs/performance.md).
Harness + reproduction steps: [`bench/README.md`](./bench/README.md).

## Security notes

- **Read-only, enforced by Postgres**: the pool's session starts with
  `default_transaction_read_only=on` — a bug or prompt injection in a tool
  handler cannot mutate Riffado, because Postgres itself rejects the write.
- **Use a dedicated read-only role anyway** (defence in depth: a session
  can `SET default_transaction_read_only=off`, a role without write grants
  can't write regardless). The server only reads `recordings`,
  `transcriptions` and `ai_enhancements`:

  ```sql
  CREATE ROLE riffado_mcp LOGIN PASSWORD '...';
  GRANT CONNECT ON DATABASE riffado TO riffado_mcp;
  GRANT USAGE ON SCHEMA public TO riffado_mcp;
  GRANT SELECT ON recordings, transcriptions, ai_enhancements TO riffado_mcp;
  ```

  then `DATABASE_URL=postgresql://riffado_mcp:...@riffado-db:5432/riffado`.

- **Encrypt the DB connection off-host**: when Postgres is not on the same
  host or Docker network, add `?sslmode=require` to `DATABASE_URL` (or
  `verify-full` with the server's CA), otherwise ciphertext _and_ the
  credentials cross the network in the clear.
- **No plaintext at rest, ever**: recordings are decrypted in memory on
  each cache refresh (default TTL 60s) and never written to disk.
- **No audio, no storage paths, no credentials, no other users' rows** are
  exposed by any tool.
- Container runs rootless (`7333:7333`), `--read-only`, `cap-drop: ALL`.

## License

[MIT](./LICENSE)
