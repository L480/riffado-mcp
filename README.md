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

| Tool                        | What it does                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `riffado_list_recordings`   | List recordings (newest first by default), with title, date, duration, transcript sources, optional summary snippet.                           |
| `riffado_search`            | Full-text search over transcripts/summaries/key points/action items — runs in-process (the DB only holds ciphertext), ranked by term coverage. |
| `riffado_get_recording`     | Full detail for one recording: metadata, summary, key points, action items, a pageable transcript slice.                                       |
| `riffado_list_action_items` | Flattened action items across recordings, each tagged with its source recording.                                                               |
| `riffado_stats`             | Recording count, total/median duration, first/last date, transcripts per source/provider, coverage gaps.                                       |

Also: resource `riffado://index` (markdown index), resource template
`riffado://recording/{id}`, and prompt `riffado_ask` (carries the answering
rules — cite date+title, quote verbatim, transcript beats AI summary, flag
ASR misreads, never fill gaps from general knowledge).

## Environment variables

| Var                       | Default                           | Notes                                                                                                       |
| ------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | _required_                        | `postgresql://postgres:…@riffado-db:5432/riffado`                                                           |
| `ENCRYPTION_KEY`          | _required_                        | 64 hex chars (32-byte AES key)                                                                              |
| `RIFFADO_USER_ID`         | —                                 | restrict to one user                                                                                        |
| `RIFFADO_APP_URL`         | —                                 | e.g. `https://riffado.example.com` → deep links in tool output                                              |
| `TRANSPORT`               | `stdio`                           | `stdio` \| `http`                                                                                           |
| `HTTP_PORT` / `HTTP_HOST` | `3000` / `localhost`              | container sets host `0.0.0.0`                                                                               |
| `HTTP_AUTH_TOKEN`         | —                                 | shared secret, min 32 chars when set; unset = HTTP transport runs **unauthenticated** (loud warning logged) |
| `HTTP_AUTH_HEADER_NAME`   | `x-mcp-token`                     |                                                                                                             |
| `HTTP_OAUTH_ENABLED`      | `true`                            | only effective with a token set                                                                             |
| `HTTP_PUBLIC_URL`         | —                                 | OAuth issuer; must be HTTPS unless `localhost`                                                              |
| `HTTP_OAUTH_STATE_FILE`   | `~/.riffado-mcp-oauth-state.json` | container: `/app/data/oauth-state.json`                                                                     |
| `HTTP_TRUST_PROXY`        | `1`                               | Express `trust proxy`                                                                                       |
| `HTTP_SESSION_TIMEOUT_MS` | `3600000` (1h)                    | idle-session expiry; `0` = no idle expiry (explicit opt-out, sessions close only on DELETE/transport close) |
| `CACHE_TTL_MS`            | `60000`                           | decrypted-store TTL                                                                                         |
| `DB_STATEMENT_TIMEOUT_MS` | `10000`                           | passed to the pg pool                                                                                       |

## Health checks

`GET /health` is the one route auth never gates — liveness only:
`{ status, timestamp }`. `GET /health/details` adds session count, DB
reachability and the cached recording count, and requires the same
auth as every other route (shared token/OAuth, or open if
`HTTP_AUTH_TOKEN` is unset).

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
   public HTTPS URL, and `HTTP_AUTH_TOKEN` set to a shared secret.
2. In Claude, add a custom connector pointing at
   `https://riffado-mcp.example.com/mcp`.
3. Claude opens the login page; paste the `HTTP_AUTH_TOKEN` value. Claude
   then holds a normal OAuth bearer token — the connector survives process
   restarts because OAuth state is persisted to `HTTP_OAUTH_STATE_FILE`.

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

## Security notes

- **Read-only, enforced by Postgres**: the pool's session starts with
  `default_transaction_read_only=on` — a bug or prompt injection in a tool
  handler cannot mutate Riffado, because Postgres itself rejects the write.
- **No plaintext at rest, ever**: recordings are decrypted in memory on
  each cache refresh (default TTL 60s) and never written to disk.
- **No audio, no storage paths, no credentials, no other users' rows** are
  exposed by any tool.
- Container runs rootless (`7333:7333`), `--read-only`, `cap-drop: ALL`.

## License

[MIT](./LICENSE)
