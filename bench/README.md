# Benchmark harness

Measures `RecordingStore`/`search` against a throwaway Postgres by importing
the built `dist/` output directly — not a reimplementation. Numbers from the
last run are written up in [`../docs/performance.md`](../docs/performance.md).
Needs `npm run build` first (imports `../dist/riffado/*.js`).

## Pitfall: pass a `limit`, and use a realistic search term

`seed.mjs` puts the word **"Übergabe" in every generated title** (see
`TOPICS`/filename in `seed-lib.mjs`/`seed.mjs`). A search for "Übergabe"
therefore matches 100% of recordings — a synthetic worst case, not a
realistic one.

Combined with **not passing a `limit`**, this is actively misleading: the
production `riffado_search` tool always passes a `limit` (default 10), which
caps how many hits get ranked/snippet-built. A harness that omits `limit`
measures unlimited-result snippet building — a code path production never
takes — and can produce numbers that look like a regression when nothing
regressed. This exact mistake nearly shipped a wrong conclusion once.

When extending this harness:

- Always pass `limit` (10, matching the tool default, unless you're
  specifically testing a different limit).
- Use both a **worst-case term** ("Übergabe" — matches ~everything) and a
  **realistic term** ("Wärmepumpe" — matches roughly 1/10 of recordings, one
  of ten `TOPICS`) so results distinguish "pathological corpus" from
  "typical query."

`bench.mjs` already does both; keep that pattern for new query sets.

## Running it

From a clean checkout:

```bash
npm install
npm run build   # bench/bench.mjs imports dist/riffado/*.js

# throwaway Postgres, port 5544, tmpfs (never the real riffado-db)
docker run -d --name riffado-bench-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=riffado_bench \
  -p 127.0.0.1:5544:5432 \
  --tmpfs /var/lib/postgresql/data \
  postgres:16-alpine

# wait for it to accept connections
until docker exec riffado-bench-pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done

cd bench
node seed.mjs 1000              # applies test/integration/schema.sql, then seeds N rows
REPS=20 node --expose-gc bench.mjs 1000

# teardown
docker rm -f riffado-bench-pg
```

Repeat `seed.mjs`/`bench.mjs` with a different N (e.g. 5000, 20000) to
reproduce the other rows in `docs/performance.md`. `--expose-gc` lets the
harness force a GC before each memory snapshot; without it the RSS deltas
are noisier. `DEEP_REPS` (default 5) controls how many reps the slow
`deep: true` case gets — its cost scales with N per rep, so 20 reps at
N=20000 would take unreasonably long.
