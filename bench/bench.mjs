// v0.2.0 two-stage-store benchmark. Imports the shipped dist/ output
// directly, against a throwaway Postgres (see README.md — port 5544,
// tmpfs). Never touches a real database.
//   npm run build && REPS=20 node --expose-gc bench.mjs <N>
import pg from "pg"
import path from "path"
import { fileURLToPath } from "url"
import { encryptForTest, randomSummary } from "./seed-lib.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(__dirname, "../dist/riffado")
const { RecordingStore } = await import(`${DIST}/store.js`)
const { rankByCheapFields, finalizeSearch, computeCandidateK, normalize, parseQueryTerms } =
  await import(`${DIST}/search.js`)
const { sliceText } = await import(`${DIST}/format.js`)

const N = parseInt(process.argv[2] ?? "1000", 10)
const REPS = parseInt(process.env.REPS ?? "20", 10)
const CHANGED_COUNT = Math.min(10, N)
const ENCRYPTION_KEY = Buffer.from("11".repeat(32), "hex")

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}
async function timeRunsAsync(fn, runs) {
  const times = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return { p50: percentile(times, 50), p95: percentile(times, 95) }
}
function gc() {
  if (global.gc) {
    global.gc()
    global.gc()
  }
}
function mem() {
  const m = process.memoryUsage()
  return { rssMB: m.rss / 1048576, heapUsedMB: m.heapUsed / 1048576 }
}

// Mirrors riffado-tools.ts's riffado_search handler exactly (limit defaults to 10, the
// tool's real default), so this measures the production code path, not a reimplementation.
async function twoStageSearch(
  store,
  recordings,
  normalizedFieldsById,
  query,
  { scope, limit, deep },
) {
  const terms = parseQueryTerms(query)
  const normalizedTerms = terms.map((t) => normalize(t))
  const ranked = rankByCheapFields(recordings, normalizedFieldsById, normalizedTerms)

  let candidateIds = new Set()
  let transcriptsById = new Map()
  if (scope !== "summary" && normalizedTerms.length > 0) {
    const k = computeCandidateK(limit)
    const candidateRecordings = deep ? recordings : ranked.slice(0, k).map((c) => c.recording)
    candidateIds = new Set(candidateRecordings.map((r) => r.id))
    transcriptsById = await store.getTranscripts(candidateRecordings.map((r) => r.id))
  }
  return finalizeSearch(ranked, terms, normalizedTerms, scope, candidateIds, transcriptsById, {
    contextChars: 300,
    limit,
  })
}

async function main() {
  const pool = new pg.Pool({
    connectionString: "postgres://postgres:postgres@127.0.0.1:5544/riffado_bench",
    max: 4,
  })
  let lastSqlMs = 0
  const originalQuery = pool.query.bind(pool)
  pool.query = async (...args) => {
    const t0 = performance.now()
    const r = await originalQuery(...args)
    lastSqlMs = performance.now() - t0
    return r
  }

  gc()
  const baseline = mem()

  const store = new RecordingStore({ pool, encryptionKey: ENCRYPTION_KEY, cacheTtlMs: 60000 })

  // 1) cold get() -- metadata only, no transcript text/decrypt.
  const t0 = performance.now()
  const recordings = await store.get()
  const coldTotalMs = performance.now() - t0
  const coldSqlMs = lastSqlMs
  const coldDecryptBuildMs = coldTotalMs - coldSqlMs

  gc()
  const afterCold = mem()

  // Same cached snapshot as the cold get() above (well within cacheTtlMs) -- no extra query.
  const normalizedFieldsById = await store.getNormalizedFields()

  // 1b) unchanged refresh: the corpus hasn't changed, so every recording's stamp should
  // match and refresh() should reuse every cached entry -- no decrypt, no re-normalize.
  // `store.cachedAt` is a bench-only reach into the store's TTL bookkeeping (present in the
  // compiled dist/ output even though the TS source marks it `private`) to force refresh()
  // to run again while the previous snapshot -- and its stamps -- survives; `invalidate()`
  // would drop the stamps too and defeat the point of this measurement.
  store.cachedAt = 0
  const u0 = performance.now()
  const recordingsUnchanged = await store.get()
  const unchangedTotalMs = performance.now() - u0
  const unchangedSqlMs = lastSqlMs
  const unchangedDecryptBuildMs = unchangedTotalMs - unchangedSqlMs
  const reusedAll =
    recordingsUnchanged.length === recordings.length &&
    recordingsUnchanged.every((r, i) => r === recordings[i])

  gc()
  const afterUnchanged = mem()

  // 1c) refresh after mutating a handful of recordings: re-encrypts (fresh IV) a few
  // summaries directly against the bench Postgres -- same at-rest format Riffado itself
  // writes -- then times a refresh that must rebuild just those, reusing the rest.
  const changedIds = Array.from({ length: CHANGED_COUNT }, (_, i) => `rec-${i}`)
  for (const id of changedIds) {
    const i = Number(id.slice(4))
    await pool.query("UPDATE ai_enhancements SET summary = $1 WHERE recording_id = $2", [
      encryptForTest(`${randomSummary(i)} (edited for bench)`),
      id,
    ])
  }

  store.cachedAt = 0
  const c0 = performance.now()
  const recordingsChanged = await store.get()
  const changedTotalMs = performance.now() - c0
  const changedSqlMs = lastSqlMs
  const changedDecryptBuildMs = changedTotalMs - changedSqlMs
  const changedById = new Map(recordingsChanged.map((r) => [r.id, r]))
  const unchangedById = new Map(recordingsUnchanged.map((r) => [r.id, r]))
  const rebuiltCount = changedIds.filter(
    (id) => changedById.get(id) !== unchangedById.get(id),
  ).length

  gc()
  const afterChanged = mem()

  // 2) search latency, worst case ("ubergabe" is in every title -- see seed.mjs, and
  // README.md's pitfall note) and realistic case ("warmepumpe" is one of ten topics,
  // only in ~1/10 summaries/transcripts).
  const queries = {
    "1-term-worst": "Übergabe",
    "3-term-worst": "Übergabe heating café",
    "1-term-realistic": "Wärmepumpe",
    "3-term-realistic": "Wärmepumpe Inspektion Techniker",
  }
  // deep: true re-fetches + decrypts every candidate's transcript from Postgres on every
  // call (the LRU, default capacity 50, can't hold a corpus-wide candidate set), so its
  // cost scales with N per rep -- a handful of reps is enough to get a stable p50/p95
  // without the benchmark itself taking many extra minutes at N=5000/20000.
  const DEEP_REPS = parseInt(process.env.DEEP_REPS ?? "5", 10)

  const searchResults = {}
  for (const [label, query] of Object.entries(queries)) {
    for (const [modeLabel, opts, reps] of [
      ["scope=summary", { scope: "summary", limit: 10, deep: false }, REPS],
      ["scope=all(two-stage)", { scope: "all", limit: 10, deep: false }, REPS],
      ["deep=true", { scope: "all", limit: 10, deep: true }, DEEP_REPS],
    ]) {
      const key = `${label}/${modeLabel}`
      const { p50, p95 } = await timeRunsAsync(
        () => twoStageSearch(store, recordings, normalizedFieldsById, query, opts),
        reps,
      )
      searchResults[key] = { p50, p95, reps }
    }
  }

  // 3) riffado_get_recording equivalent: on-demand transcript fetch + slice for one
  // large transcript. First call is cold (query + decrypt); repeats hit the LRU.
  const target = recordings.find((r) => r.transcripts.length > 0) ?? recordings[0]
  store.invalidate() // drop the LRU so the first fetch below is a true cold fetch
  const coldFetchT0 = performance.now()
  const coldTexts = (await store.getTranscripts([target.id])).get(target.id)
  const coldFetchMs = performance.now() - coldFetchT0
  const bigText = coldTexts[0].text

  const { p50: warmFetchP50, p95: warmFetchP95 } = await timeRunsAsync(async () => {
    const texts = (await store.getTranscripts([target.id])).get(target.id)
    const offset = Math.floor(Math.random() * Math.max(1, texts[0].text.length - 20000))
    sliceText(texts[0].text, offset, 20000)
  }, 25)

  await pool.end()

  console.log(
    JSON.stringify(
      {
        N,
        changedCount: CHANGED_COUNT,
        cachedCount: store.getCachedCount(),
        refresh: {
          cold: { totalMs: coldTotalMs, sqlMs: coldSqlMs, decryptBuildMs: coldDecryptBuildMs },
          unchanged: {
            totalMs: unchangedTotalMs,
            sqlMs: unchangedSqlMs,
            decryptBuildMs: unchangedDecryptBuildMs,
            reusedAllReferenceIdentical: reusedAll,
          },
          changed: {
            totalMs: changedTotalMs,
            sqlMs: changedSqlMs,
            decryptBuildMs: changedDecryptBuildMs,
            rebuiltCount,
          },
        },
        memory: {
          baselineRssMB: baseline.rssMB,
          baselineHeapUsedMB: baseline.heapUsedMB,
          afterColdRssMB: afterCold.rssMB,
          afterColdHeapUsedMB: afterCold.heapUsedMB,
          afterUnchangedRssMB: afterUnchanged.rssMB,
          afterChangedRssMB: afterChanged.rssMB,
          deltaRssMB: afterCold.rssMB - baseline.rssMB,
          deltaHeapUsedMB: afterCold.heapUsedMB - baseline.heapUsedMB,
          deltaUnchangedRefreshRssMB: afterUnchanged.rssMB - afterCold.rssMB,
          deltaChangedRefreshRssMB: afterChanged.rssMB - afterUnchanged.rssMB,
        },
        search: searchResults,
        getRecordingTranscript: {
          coldFetchMs,
          warmFetchP50,
          warmFetchP95,
          transcriptLen: bigText.length,
        },
      },
      null,
      2,
    ),
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
