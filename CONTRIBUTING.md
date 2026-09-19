# Contributing

Thanks for considering a contribution to `riffado-mcp`.

## Development setup

```bash
npm install
npm run build
```

## Before opening a PR

```bash
npm run lint          # eslint
npm run format:check  # prettier --check
npm run typecheck     # tsc --noEmit, src + test
npm test              # vitest, unit tests
```

All four must pass. CI enforces the same checks on Node 20/22/24, plus the
integration suite against a real Postgres, a Docker build smoke test,
`hadolint`, and a Trivy filesystem scan.

Integration tests need a database:

```bash
docker compose -f docker-compose.test.yml up -d
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/riffado_test \
  npm run test:integration
docker compose -f docker-compose.test.yml down
```

## Invariants a PR must not break

These are load-bearing, and each one is a bug that was already paid for once:

1. **Read-only stays enforced at the database layer.** The pool pins
   `default_transaction_read_only=on`; the integration suite asserts that an
   `INSERT` through the app's own pool is rejected by Postgres. Don't add write
   tools, and don't relax the pool setting to work around a failing query.
2. **Nothing is printed to stdout on the stdio transport.** stdout is the
   JSON-RPC channel — one stray `console.log` (or a library banner, which is
   why `dotenv` is configured with `quiet: true`) corrupts every message. Log
   to stderr.
3. **Decrypted content never touches disk.** Recordings are decrypted into the
   in-memory `RecordingStore` only -- metadata in its refresh cache, transcript
   text in its on-demand LRU (`getTranscripts`). Neither is ever written out.
4. **Search stays in-process.** The database only ever holds ciphertext, so
   there is nothing to index in SQL — see
   [`docs/architecture.md`](./docs/architecture.md).
5. **The HTTP transport keeps its quirks.** MCP is mounted at both `/mcp` and
   `/`, an unknown session answers `404` (not `400`) so clients silently
   re-initialize, `trust proxy` is set so the rate limiter works behind a
   reverse proxy, and `401` carries a RFC 9728 `WWW-Authenticate` challenge.
   Each of those is a fix for a real client failure, not incidental.

## Commits

Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `test:`, `build:`,
`chore:`). Releases are cut by pushing a `v*` tag, which triggers the image
build and the GitHub Release.
