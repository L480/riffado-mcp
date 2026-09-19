// Bulk-seeds the throwaway riffado_bench Postgres with N realistic
// recordings (real at-rest encryption format). Applies the schema from
// test/integration/schema.sql first (CREATE TABLE IF NOT EXISTS, so this
// is safe to rerun). Run: node seed.mjs <N>
import pg from "pg"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import {
  encryptForTest,
  encJson,
  randomTranscript,
  randomSummary,
  randomKeyPoints,
  randomActionItems,
} from "./seed-lib.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = path.join(__dirname, "../test/integration/schema.sql")

const N = parseInt(process.argv[2] ?? "1000", 10)
const BATCH = 200

const pool = new pg.Pool({
  connectionString: "postgres://postgres:postgres@127.0.0.1:5544/riffado_bench",
  max: 4,
})

function nowMinusDays(days) {
  const d = new Date(Date.now() - days * 86400000)
  return d.toISOString().replace("T", " ").replace("Z", "").slice(0, 19)
}

async function main() {
  const t0 = Date.now()
  await pool.query(fs.readFileSync(SCHEMA_PATH, "utf-8"))
  await pool.query("TRUNCATE ai_enhancements, transcriptions, recordings")

  for (let start = 0; start < N; start += BATCH) {
    const end = Math.min(start + BATCH, N)
    const recValues = []
    const recParams = []
    const trValues = []
    const trParams = []
    const aiValues = []
    const aiParams = []

    for (let i = start; i < end; i++) {
      const id = `rec-${i}`
      const filename = encryptForTest(`Aufnahme ${i} - café Übergabe.m4a`)
      const duration = 300 + (i % 1800)
      const startTime = nowMinusDays(N - i)

      recParams.push(id, "bench-user", filename, duration, startTime, false, null)
      const b = recParams.length - 7
      recValues.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`)

      const text = encryptForTest(randomTranscript(i))
      trParams.push(`t-${i}`, id, "bench-user", text, "openai", "whisper-1", "de", "riffado")
      const c = trParams.length - 8
      trValues.push(
        `($${c + 1},$${c + 2},$${c + 3},$${c + 4},$${c + 5},$${c + 6},$${c + 7},$${c + 8})`,
      )

      const summary = encryptForTest(randomSummary(i))
      // Both encrypted-wrapper jsonb -- the normal production shape (docs/architecture.md:
      // these columns are ciphertext at rest). Plain/unwrapped key_points (as in the
      // integration fixture's rec-active) is a real but non-default shape, covered by its
      // own dedicated store test -- see docs/performance.md's incremental-refresh section.
      const keyPoints = encJson(randomKeyPoints(i))
      const actionItems = encJson(randomActionItems(i))
      aiParams.push(
        `e-${i}`,
        id,
        "bench-user",
        summary,
        keyPoints,
        actionItems,
        "openai",
        "gpt-4o-mini",
        "riffado",
      )
      const d = aiParams.length - 9
      aiValues.push(
        `($${d + 1},$${d + 2},$${d + 3},$${d + 4},$${d + 5},$${d + 6},$${d + 7},$${d + 8},$${d + 9})`,
      )
    }

    await pool.query(
      `INSERT INTO recordings (id, user_id, filename, duration, start_time, is_trash, deleted_at) VALUES ${recValues.join(",")}`,
      recParams,
    )
    await pool.query(
      `INSERT INTO transcriptions (id, recording_id, user_id, text, provider, model, detected_language, source) VALUES ${trValues.join(",")}`,
      trParams,
    )
    await pool.query(
      `INSERT INTO ai_enhancements (id, recording_id, user_id, summary, key_points, action_items, provider, model, source) VALUES ${aiValues.join(",")}`,
      aiParams,
    )

    if ((start / BATCH) % 10 === 0) {
      process.stderr.write(`seeded ${end}/${N}\n`)
    }
  }

  const { rows } = await pool.query("SELECT count(*)::int AS c FROM recordings")
  process.stderr.write(`done: ${rows[0].c} recordings in ${Date.now() - t0}ms\n`)
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
