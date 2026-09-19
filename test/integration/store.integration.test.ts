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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createPool } from "../../src/riffado/db.js"
import { parseEncryptionKey } from "../../src/riffado/crypto.js"
import { RecordingStore } from "../../src/riffado/store.js"
import { encJson, encryptForTest, migrate, seed, TEST_ENCRYPTION_KEY } from "./seed.js"

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

  it("groups several transcript sources onto one recording, as descriptors without text", async () => {
    const recordings = await store.get()
    const active = recordings.find((r) => r.id === "rec-active")
    const sources = active!.transcripts.map((t) => t.source).sort()
    expect(sources).toEqual(["manual", "riffado"])
    for (const t of active!.transcripts) {
      expect(t).not.toHaveProperty("text")
      expect(typeof t.textLength).toBe("number")
      expect(t.textLength).toBeGreaterThan(0)
    }
  })

  it("getTranscripts decrypts text for requested ids in one query, keyed by recording id + source", async () => {
    const querySpy = vi.spyOn(pool, "query")
    const byId = await store.getTranscripts(["rec-active"])
    expect(querySpy).toHaveBeenCalledTimes(1)
    querySpy.mockRestore()

    const texts = byId.get("rec-active")!
    expect(texts.find((t) => t.source === "riffado")!.text).toBe(
      "Wir sprechen heute über die Kita-Übergabe.",
    )
    expect(texts.find((t) => t.source === "manual")!.text).toBe("Manuell nachgetragene Notizen.")
  })

  it("getTranscripts never returns a trashed or deleted recording's text, even if asked by id", async () => {
    const byId = await store.getTranscripts(["rec-active", "rec-trashed", "rec-deleted"])
    expect(byId.get("rec-trashed")).toEqual([])
    expect(byId.get("rec-deleted")).toEqual([])
    expect(byId.get("rec-active")!.length).toBeGreaterThan(0)
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

  // From here on: incremental refresh against a real Postgres, using
  // `setupClient` (unrestricted) to mutate rows exactly like Riffado itself
  // would, then re-querying through the app's own store. `store` was built
  // with `cacheTtlMs: 0`, so every `get()` re-runs refresh().
  //
  // These tests target a purpose-seeded "rec-stamp" recording -- fully
  // v1:-encrypted in all four stamped fields (filename, summary, and both
  // key_points/action_items as the encrypted jsonb wrapper) -- rather than
  // `rec-active`. `rec-active` deliberately has *plain* (unwrapped)
  // key_points (see seed.ts) to exercise that jsonb shape elsewhere; under
  // phase 1's prefix-only stamp, a plain/unwrapped field can never be
  // verified unchanged from a prefix alone, so `rec-active` is always
  // rebuilt regardless of what these tests do -- see the last test below,
  // which asserts exactly that instead of fighting it.
  describe("incremental refresh", () => {
    beforeAll(async () => {
      await setupClient.query(
        `INSERT INTO recordings (id, user_id, filename, duration, start_time, is_trash, deleted_at)
         VALUES ($1, $2, $3, $4, $5, false, NULL)`,
        ["rec-stamp", "u1", encryptForTest("Stamp Test Recording"), 60000, "2026-09-16 08:00:00"],
      )
      await setupClient.query(
        `INSERT INTO transcriptions (id, recording_id, user_id, text, provider, model, detected_language, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          "t-stamp-riffado",
          "rec-stamp",
          "u1",
          encryptForTest("Ursprünglicher Transkripttext."),
          "openai",
          "whisper-1",
          "de",
          "riffado",
        ],
      )
      await setupClient.query(
        `INSERT INTO ai_enhancements (id, recording_id, user_id, summary, key_points, action_items, provider, model, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          "e-stamp",
          "rec-stamp",
          "u1",
          encryptForTest("Ursprüngliche Zusammenfassung."),
          encJson(["Ursprünglicher Punkt"]), // encrypted-wrapper jsonb -- unlike rec-active's plain array
          encJson([{ who: "Nico", what: "Ursprüngliche Aktion" }]),
          "openai",
          "gpt-4o-mini",
          "riffado",
        ],
      )
    })

    it("an unchanged second refresh reuses the cached recording object verbatim", async () => {
      const first = await store.get()
      const firstStamp = first.find((r) => r.id === "rec-stamp")!

      const second = await store.get()
      const secondStamp = second.find((r) => r.id === "rec-stamp")!

      expect(secondStamp).toBe(firstStamp)
    })

    it("re-encrypting a summary is noticed and rebuilds just that recording", async () => {
      const before = (await store.get()).find((r) => r.id === "rec-stamp")!

      await setupClient.query("UPDATE ai_enhancements SET summary = $1 WHERE recording_id = $2", [
        encryptForTest("Neue Zusammenfassung nach Re-Encryption."),
        "rec-stamp",
      ])

      const after = (await store.get()).find((r) => r.id === "rec-stamp")!
      expect(after).not.toBe(before)
      expect(after.summary).toBe("Neue Zusammenfassung nach Re-Encryption.")

      // Restore, then confirm the store settles back into reusing it (not stuck rebuilding).
      await setupClient.query("UPDATE ai_enhancements SET summary = $1 WHERE recording_id = $2", [
        encryptForTest("Ursprüngliche Zusammenfassung."),
        "rec-stamp",
      ])
      const restored = (await store.get()).find((r) => r.id === "rec-stamp")!
      expect(restored.summary).toBe("Ursprüngliche Zusammenfassung.")
      const restoredAgain = (await store.get()).find((r) => r.id === "rec-stamp")!
      expect(restoredAgain).toBe(restored) // reused once settled, not permanently forced to rebuild
    })

    it("a re-encrypted key_points/action_items jsonb wrapper is noticed", async () => {
      const before = (await store.get()).find((r) => r.id === "rec-stamp")!
      expect(before.keyPoints).toEqual(["Ursprünglicher Punkt"])

      await setupClient.query(
        "UPDATE ai_enhancements SET key_points = $1 WHERE recording_id = $2",
        [encJson(["Neuer Punkt"]), "rec-stamp"],
      )

      const after = (await store.get()).find((r) => r.id === "rec-stamp")!
      expect(after).not.toBe(before)
      expect(after.keyPoints).toEqual(["Neuer Punkt"])
    })

    it("an added transcript source is noticed", async () => {
      const before = (await store.get()).find((r) => r.id === "rec-stamp")!
      expect(before.transcripts.map((t) => t.source)).toEqual(["riffado"])

      await setupClient.query(
        `INSERT INTO transcriptions (id, recording_id, user_id, text, provider, model, detected_language, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          "t-stamp-extra",
          "rec-stamp",
          "u1",
          encryptForTest("Zusätzliche Quelle."),
          "human",
          "n/a",
          "de",
          "extra",
        ],
      )

      const after = (await store.get()).find((r) => r.id === "rec-stamp")!
      expect(after).not.toBe(before)
      expect(after.transcripts.map((t) => t.source).sort()).toEqual(["extra", "riffado"])
    })

    it("a removed transcript source is noticed", async () => {
      const before = (await store.get()).find((r) => r.id === "rec-stamp")!
      expect(before.transcripts.map((t) => t.source)).toContain("extra")

      await setupClient.query("DELETE FROM transcriptions WHERE id = $1", ["t-stamp-extra"])

      const after = (await store.get()).find((r) => r.id === "rec-stamp")!
      expect(after).not.toBe(before)
      expect(after.transcripts.map((t) => t.source)).toEqual(["riffado"])
    })

    it("invalidate() forces a full rebuild even with nothing changed", async () => {
      const before = (await store.get()).find((r) => r.id === "rec-stamp")!
      store.invalidate()
      const after = (await store.get()).find((r) => r.id === "rec-stamp")!

      expect(after).not.toBe(before)
      expect(after).toEqual(before)
    })

    it("a recording with plain (unwrapped) key_points -- rec-active -- is always rebuilt, never reused, since a prefix can't verify a plain jsonb value unchanged", async () => {
      const first = (await store.get()).find((r) => r.id === "rec-active")!
      const second = (await store.get()).find((r) => r.id === "rec-active")!

      expect(second).not.toBe(first)
      expect(second).toEqual(first) // still correct content, just never cheaply verified unchanged
    })
  })
})
