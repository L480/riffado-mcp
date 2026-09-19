import { describe, expect, it, vi } from "vitest"
import { RecordingStore } from "../../../src/riffado/store.js"
import { encryptForTest, TEST_ENCRYPTION_KEY } from "../../integration/seed.js"

function fakePool(handlers: { metadata?: unknown[]; transcripts?: unknown[] }) {
  const calls: { query: string; params: unknown[] }[] = []
  const query = vi.fn(async (query: string, params: unknown[] = []) => {
    calls.push({ query, params })
    // Distinguish the two queries by a substring unique to each.
    if (query.includes("FROM transcriptions")) {
      return { rows: handlers.transcripts ?? [] }
    }
    return { rows: handlers.metadata ?? [] }
  })
  return { pool: { query } as unknown as import("pg").Pool, calls }
}

const KEY = Buffer.from(TEST_ENCRYPTION_KEY, "hex")

function metaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rec-1",
    user_id: "u1",
    filename: encryptForTest("A title"),
    duration: 1000,
    start_time: "2026-01-01 00:00:00",
    source: "riffado",
    provider: "openai",
    model: "whisper-1",
    detected_language: "de",
    text_length: 42,
    summary: null,
    key_points: null,
    action_items: null,
    ...overrides,
  }
}

describe("RecordingStore.get() metadata query", () => {
  it("never selects transcript text as a plain column", async () => {
    const { pool, calls } = fakePool({ metadata: [metaRow()] })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 60000 })
    await store.get()
    const metadataCall = calls.find((c) => !c.query.includes("FROM transcriptions"))
    expect(metadataCall).toBeDefined()
    // t.text may appear inside function calls (length(t.text), left(t.text, 3) -- used only
    // to estimate a character count server-side) but never as its own selected column.
    expect(metadataCall!.query).not.toMatch(/(^|,)\s*t\.text\s*(,|FROM)/im)
  })

  it("returns descriptors with textLength but no text property", async () => {
    const { pool } = fakePool({ metadata: [metaRow()] })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 60000 })
    const recordings = await store.get()
    expect(recordings).toHaveLength(1)
    const [descriptor] = recordings[0].transcripts
    expect(descriptor).not.toHaveProperty("text")
    expect(descriptor.textLength).toBe(42)
  })
})

describe("RecordingStore.getTranscripts()", () => {
  it("batches many ids into one query", async () => {
    const { pool, calls } = fakePool({
      transcripts: [
        { recording_id: "a", source: "riffado", text: encryptForTest("text a") },
        { recording_id: "b", source: "riffado", text: encryptForTest("text b") },
        { recording_id: "c", source: "riffado", text: encryptForTest("text c") },
      ],
    })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 60000 })
    const byId = await store.getTranscripts(["a", "b", "c"])

    expect(calls).toHaveLength(1)
    expect(byId.get("a")![0].text).toBe("text a")
    expect(byId.get("b")![0].text).toBe("text b")
    expect(byId.get("c")![0].text).toBe("text c")
  })

  it("the LRU serves a repeated id from cache, without a second query", async () => {
    const { pool, calls } = fakePool({
      transcripts: [{ recording_id: "a", source: "riffado", text: encryptForTest("text a") }],
    })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 60000 })

    await store.getTranscripts(["a"])
    expect(calls).toHaveLength(1)

    await store.getTranscripts(["a"])
    expect(calls).toHaveLength(1) // still 1 -- served from the LRU, no refetch
  })

  it("a partial cache hit only queries for the miss", async () => {
    const { pool, calls } = fakePool({
      transcripts: [
        { recording_id: "a", source: "riffado", text: encryptForTest("text a") },
        { recording_id: "b", source: "riffado", text: encryptForTest("text b") },
      ],
    })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 60000 })

    await store.getTranscripts(["a"])
    expect(calls).toHaveLength(1)

    await store.getTranscripts(["a", "b"])
    expect(calls).toHaveLength(2)
    expect(calls[1].params[0]).toEqual(["b"]) // only the miss, not "a" again
  })

  it("evicts the least-recently-used id once the LRU is over capacity", async () => {
    const { pool, calls } = fakePool({
      transcripts: [
        { recording_id: "a", source: "riffado", text: encryptForTest("text a") },
        { recording_id: "b", source: "riffado", text: encryptForTest("text b") },
      ],
    })
    const store = new RecordingStore({
      pool,
      encryptionKey: KEY,
      cacheTtlMs: 60000,
      transcriptCacheSize: 1,
    })

    await store.getTranscripts(["a"])
    await store.getTranscripts(["b"]) // evicts "a" (capacity 1)
    expect(calls).toHaveLength(2)

    await store.getTranscripts(["a"]) // "a" was evicted -- must refetch
    expect(calls).toHaveLength(3)
  })

  it("invalidate() drops the LRU too", async () => {
    const { pool, calls } = fakePool({
      transcripts: [{ recording_id: "a", source: "riffado", text: encryptForTest("text a") }],
    })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 60000 })

    await store.getTranscripts(["a"])
    store.invalidate()
    await store.getTranscripts(["a"])
    expect(calls).toHaveLength(2)
  })
})
