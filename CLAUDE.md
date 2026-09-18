# riffado-mcp

Read-only MCP server over the Riffado Postgres DB. See `README.md` for
tools/env vars, `docs/architecture.md` for the why.

## Commands

```
npm run lint          # eslint
npm run format:check  # prettier --check (npm run format to fix)
npm run typecheck     # tsc --noEmit, src + test
npm test              # vitest, unit tests only
npm run test:integration  # needs TEST_DATABASE_URL, see docker-compose.test.yml
npm run build          # tsc -> dist/
```

## Rules

- **Strictly read-only against Riffado.** Every query is a parameterized
  `SELECT`; the pool's `default_transaction_read_only=on` is the real
  guard, not application logic — never work around it.
- **stdio transport: all logging goes to stderr.** stdout is the JSON-RPC
  channel; anything printed there (including a library's own startup
  banner — see dotenv's `quiet: true` in `config.ts`) corrupts every
  message.
- **Never commit real tokens/keys.** `ENCRYPTION_KEY`, `DATABASE_URL`
  credentials and `HTTP_AUTH_TOKEN` come from the environment only.
- Decrypted recordings live in memory only (`RecordingStore`, TTL
  `CACHE_TTL_MS`) — never write them to disk.
