/**
 * Runs against a real Postgres. Skipped unless TEST_DATABASE_URL is set —
 * see README.md "Development" for how to start one locally
 * (docker-compose.test.yml), or let CI's service container provide it.
 *
 * Proves two things no unit test can: the decrypt path works end-to-end
 * through a real query round-trip, and the read-only transaction guard
 * (`default_transaction_read_only=on`) actually stops a write at the
 * Postgres level, not just in application code.
 */
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createPool } from "../../src/riffado/db.js"
import { parseEncryptionKey } from "../../src/riffado/crypto.js"
import { RecordingStore } from "../../src/riffado/store.js"
import { migrate, seed, TEST_ENCRYPTION_KEY } from "./seed.js"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)("RecordingStore against a real Postgres", () => {
  // A plain, unrestricted client for schema setup + seeding — the app's own
  // pool (created below) is read-only by construction and must never be
  // used for this.
  let setupClient: pg.Client
  let pool: pg.Pool
  let store: RecordingStore

  beforeAll(async () => {
    setupClient = new pg.Client({ connectionString: TEST_DATABASE_URL })
    await setupClient.connect()
    await migrate(setupClient)
    await seed(setupClient)

    pool = createPool({ connectionString: TEST_DATABASE_URL!, statementTimeoutMs: 5000 })
    store = new RecordingStore({
      pool,
      encryptionKey: parseEncryptionKey(TEST_ENCRYPTION_KEY),
      cacheTtlMs: 0,
    })
  })

  afterAll(async () => {
    await pool?.end()
    await setupClient?.end()
  })

  it("decrypts filename, transcript text, summary and key points end-to-end", async () => {
    const recordings = await store.get()
    const active = recordings.find((r) => r.id === "rec-active")
    expect(active).toBeDefined()
    expect(active!.title).toBe("Kita Übergabe")
    expect(active!.summary).toBe("Besprochen wurde die Kita-Übergabe.")
    expect(active!.keyPoints).toEqual(["Neue Erzieherin ab Oktober"])
  })

  it("decrypts an encrypted-jsonb-wrapper action_items column", async () => {
    const recordings = await store.get()
    const active = recordings.find((r) => r.id === "rec-active")
    expect(active!.actionItems).toEqual(["Nico — Formular unterschreiben"])
  })

  it("excludes is_trash and deleted_at rows", async () => {
    const recordings = await store.get()
    const ids = recordings.map((r) => r.id)
    expect(ids).not.toContain("rec-trashed")
    expect(ids).not.toContain("rec-deleted")
  })

  it("groups several transcript sources onto one recording", async () => {
    const recordings = await store.get()
    const active = recordings.find((r) => r.id === "rec-active")
    const sources = active!.transcripts.map((t) => t.source).sort()
    expect(sources).toEqual(["manual", "riffado"])
    expect(active!.transcripts.find((t) => t.source === "riffado")!.text).toBe(
      "Wir sprechen heute über die Kita-Übergabe.",
    )
    expect(active!.transcripts.find((t) => t.source === "manual")!.text).toBe(
      "Manuell nachgetragene Notizen.",
    )
  })

  it("passes a legacy unencrypted filename through unchanged", async () => {
    const recordings = await store.get()
    const legacy = recordings.find((r) => r.id === "rec-legacy")
    expect(legacy!.title).toBe("Legacy Plaintext Title")
  })

  it("rejects a write through the app's pool — Postgres itself enforces read-only", async () => {
    await expect(
      pool.query(
        "INSERT INTO recordings (id, user_id, filename, duration, start_time) VALUES ($1, $2, $3, $4, $5)",
        ["should-fail", "u1", "x", 1, "2026-01-01 00:00:00"],
      ),
    ).rejects.toThrow(/read-only/i)
  })

  it("rejects an UPDATE and a DELETE through the app's pool too", async () => {
    await expect(
      pool.query("UPDATE recordings SET filename = 'x' WHERE id = 'rec-active'"),
    ).rejects.toThrow(/read-only/i)
    await expect(pool.query("DELETE FROM recordings WHERE id = 'rec-active'")).rejects.toThrow(
      /read-only/i,
    )
  })
})
