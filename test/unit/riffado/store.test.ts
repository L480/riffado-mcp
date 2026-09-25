import { describe, expect, it, vi } from "vitest"
import { IV_STAMP_PREFIX_LEN, JSON_IV_STAMP_PREFIX_LEN } from "../../../src/riffado/crypto.js"
import { RecordingStore } from "../../../src/riffado/store.js"
import { encryptForTest, TEST_ENCRYPTION_KEY } from "../../integration/seed.js"

const KEY = Buffer.from(TEST_ENCRYPTION_KEY, "hex")

/**
 * A fake pool distinguishing the store's three query shapes by a substring
 * unique to each (`FROM transcriptions` for `getTranscripts`, the
 * `filename_prefix` alias for refresh()'s phase-1 stamp query, anything
 * else is phase 2's full metadata query). `stamp`/`metadata` each take a
 * *sequence* of row sets -- one per successive call of that query kind
 * (the last entry repeats once exhausted) -- since phase 1 runs on every
 * refresh but phase 2 only runs when something needs rebuilding, so the two
 * don't advance in lockstep with each other or with the number of
 * `store.get()` calls.
 */
function fakePool(config: {
  stamp?: unknown[][]
  metadata?: unknown[][]
  transcripts?: unknown[]
}) {
  const calls: { kind: "stamp" | "metadata" | "transcripts"; query: string; params: unknown[] }[] =
    []
  let stampIndex = 0
  let metadataIndex = 0
  const stampSeq = config.stamp ?? []
  const metadataSeq = config.metadata ?? []
  const query = vi.fn(async (query: string, params: unknown[] = []) => {
    if (query.includes("FROM transcriptions")) {
      calls.push({ kind: "transcripts", query, params })
      return { rows: config.transcripts ?? [] }
    }
    if (query.includes("filename_prefix")) {
      calls.push({ kind: "stamp", query, params })
      const rows = stampSeq[Math.min(stampIndex, stampSeq.length - 1)] ?? []
      stampIndex++
      return { rows }
    }
    calls.push({ kind: "metadata", query, params })
    const rows = metadataSeq[Math.min(metadataIndex, metadataSeq.length - 1)] ?? []
    metadataIndex++
    return { rows }
  })
  return { pool: { query } as unknown as import("pg").Pool, calls }
}

/** Postgres's jsonb::text cast always renders the `{"c": "<v1:...>"}` wrapper with exactly
 * this spacing -- see crypto.test.ts's identical helper and crypto.ts's `JSON_WRAPPER_PREFIX`. */
function pgJsonbWrapper(cipher: string): string {
  return `{"c": "${cipher}"}`
}

/**
 * Builds a matched pair of phase-1 (stamp) and phase-2 (metadata) rows for
 * the same logical recording, mirroring what the real `STAMP_QUERY`
 * (`left(column, N)`) and `METADATA_QUERY` (full column) would actually
 * return for the same underlying data -- so a test can hand `store.get()`
 * whichever query needs which row set and have them agree, the way real
 * Postgres would.
 */
function fixture(
  overrides: {
    id?: string
    filename?: string | null
    summary?: string | null
    keyPoints?: string | null
    actionItems?: string | null
    transcriptId?: string | null
    source?: string | null
    isTrash?: boolean
    deletedAt?: string | null
    updatedAt?: string
  } = {},
) {
  const id = overrides.id ?? "rec-1"
  const filename = overrides.filename === undefined ? encryptForTest("A title") : overrides.filename
  const summary = overrides.summary === undefined ? null : overrides.summary
  const keyPoints = overrides.keyPoints === undefined ? null : overrides.keyPoints
  const actionItems = overrides.actionItems === undefined ? null : overrides.actionItems
  const transcriptId = overrides.transcriptId === undefined ? "t-1" : overrides.transcriptId
  const source = overrides.source === undefined ? "riffado" : overrides.source
  const isTrash = overrides.isTrash ?? false
  const deletedAt = overrides.deletedAt === undefined ? null : overrides.deletedAt
  const updatedAt = overrides.updatedAt ?? "2026-01-01 00:00:00"

  const stamp = {
    id,
    is_trash: isTrash,
    deleted_at: deletedAt,
    updated_at: updatedAt,
    transcript_id: transcriptId,
    source,
    filename_prefix: filename ? filename.slice(0, IV_STAMP_PREFIX_LEN) : null,
    summary_prefix: summary ? summary.slice(0, IV_STAMP_PREFIX_LEN) : null,
    key_points_prefix: keyPoints ? keyPoints.slice(0, JSON_IV_STAMP_PREFIX_LEN) : null,
    action_items_prefix: actionItems ? actionItems.slice(0, JSON_IV_STAMP_PREFIX_LEN) : null,
  }
  const meta = {
    id,
    user_id: "u1",
    filename,
    duration: 1000,
    start_time: "2026-01-01 00:00:00",
    source,
    provider: "openai",
    model: "whisper-1",
    detected_language: "de",
    text_length: 42,
    summary,
    key_points: keyPoints,
    action_items: actionItems,
  }
  return { stamp, meta }
}

/** Corrupts a `v1:iv:tag:ciphertext` value while keeping its IV segment --
 * decrypting it throws (GCM auth failure). Used to prove a field was never
 * passed to `decrypt()`: if the incremental refresh reused the cached entry
 * as designed, this poisoned value is never touched and nothing throws; if
 * it mistakenly re-decrypted an "unchanged" field, the test would fail with
 * a thrown error, not just a wrong assertion. */
function corruptedSameIv(original: string): string {
  const [, iv, , ciphertextHex] = original.split(":")
  const tag = "00".repeat(16)
  const ciphertext = "00".repeat(Math.max(1, Buffer.from(ciphertextHex, "hex").length))
  return `v1:${iv}:${tag}:${ciphertext}`
}

describe("RecordingStore incremental refresh", () => {
  it("an unchanged second refresh performs no decryption (phase 2 never runs) and returns reference-identical objects", async () => {
    const filename = encryptForTest("A title")
    const summary = encryptForTest("A summary")
    const f = fixture({ filename, summary })
    // A phase-2 row that would throw if ever decrypted -- same IV (so it would, wrongly,
    // still look "identical" to a naive full-value comparison) but corrupted tag/ciphertext.
    // It must never be consumed: an unchanged refresh should skip phase 2 entirely.
    const poisonedMeta = {
      ...f.meta,
      filename: corruptedSameIv(filename),
      summary: corruptedSameIv(summary),
    }
    const { pool, calls } = fakePool({
      stamp: [[f.stamp]], // same DB row both times -- nothing changed
      metadata: [[f.meta], [poisonedMeta]],
    })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 0 })

    const first = await store.get()
    const firstNormalized = await store.getNormalizedFields()
    const second = await store.get()
    const secondNormalized = await store.getNormalizedFields()

    expect(second[0]).toBe(first[0]) // same object reference, not just equal
    expect(second[0].title).toBe("A title")
    expect(second[0].summary).toBe("A summary")
    expect(secondNormalized.get("rec-1")).toBe(firstNormalized.get("rec-1"))
    // Phase 2 (the metadata/ciphertext query) ran exactly once -- the cold refresh -- never
    // again, proving the poisoned 2nd entry above was never touched, let alone decrypted.
    expect(calls.filter((c) => c.kind === "metadata")).toHaveLength(1)
  })

  it("a recording whose summary was re-encrypted is rebuilt", async () => {
    const f1 = fixture({ summary: encryptForTest("Old summary") })
    const f2 = fixture({ summary: encryptForTest("New summary") })
    const { pool } = fakePool({ stamp: [[f1.stamp], [f2.stamp]], metadata: [[f1.meta], [f2.meta]] })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 0 })

    const first = await store.get()
    const second = await store.get()

    expect(second[0]).not.toBe(first[0])
    expect(first[0].summary).toBe("Old summary")
    expect(second[0].summary).toBe("New summary")
  })

  it("a re-encrypted key_points/action_items jsonb wrapper is noticed and rebuilds the recording", async () => {
    const f1 = fixture({
      keyPoints: pgJsonbWrapper(encryptForTest(JSON.stringify(["old point"]))),
      actionItems: pgJsonbWrapper(encryptForTest(JSON.stringify([{ what: "old action" }]))),
    })
    const f2 = fixture({
      keyPoints: pgJsonbWrapper(encryptForTest(JSON.stringify(["old point"]))), // same plaintext, fresh IV
      actionItems: f1.meta.action_items as string, // unchanged
    })
    const { pool } = fakePool({ stamp: [[f1.stamp], [f2.stamp]], metadata: [[f1.meta], [f2.meta]] })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 0 })

    const first = await store.get()
    const second = await store.get()

    expect(first[0].keyPoints).toEqual(["old point"])
    expect(second[0]).not.toBe(first[0]) // re-encryption alone (fresh IV) is enough to rebuild
    expect(second[0].keyPoints).toEqual(["old point"])
  })

  it("a new recording appears", async () => {
    const f1 = fixture({ id: "rec-1" })
    const f2 = fixture({ id: "rec-2", transcriptId: "t-2" })
    const { pool } = fakePool({
      stamp: [[f1.stamp], [f1.stamp, f2.stamp]],
      metadata: [[f1.meta], [f2.meta]], // phase 2 only ever needs to fetch what's new/changed
    })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 0 })

    const first = await store.get()
    expect(first.map((r) => r.id)).toEqual(["rec-1"])

    const second = await store.get()
    expect(second.map((r) => r.id).sort()).toEqual(["rec-1", "rec-2"])
  })

  it("a recording that became is_trash/deleted_at disappears (dropped by phase 1's own WHERE clause)", async () => {
    const f1 = fixture({ id: "rec-1" })
    const f2 = fixture({ id: "rec-2", transcriptId: "t-2" })
    // Second phase-1 query simply omits rec-2's row -- exactly what the real STAMP_QUERY's
    // `WHERE r.deleted_at IS NULL AND NOT r.is_trash` would produce once it's trashed/deleted.
    const { pool, calls } = fakePool({
      stamp: [[f1.stamp, f2.stamp], [f1.stamp]],
      metadata: [[f1.meta, f2.meta]], // only the cold refresh needs phase 2 -- both are new
    })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 0 })

    const first = await store.get()
    expect(first.map((r) => r.id).sort()).toEqual(["rec-1", "rec-2"])

    const second = await store.get()
    expect(second.map((r) => r.id)).toEqual(["rec-1"])
    // rec-1 was unchanged, so the disappearance of rec-2 alone must not trigger phase 2.
    expect(calls.filter((c) => c.kind === "metadata")).toHaveLength(1)
  })

  it("an added transcript source is noticed", async () => {
    const f1 = fixture({ transcriptId: "t-1", source: "riffado" })
    const stamp1b = { ...f1.stamp, transcript_id: "t-2", source: "manual" }
    const meta1b = { ...f1.meta, source: "manual" }
    const { pool } = fakePool({
      stamp: [[f1.stamp], [f1.stamp, stamp1b]],
      metadata: [[f1.meta], [f1.meta, meta1b]], // phase 2 refetches all of rec-1's rows
    })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 0 })

    const first = await store.get()
    expect(first[0].transcripts.map((t) => t.source)).toEqual(["riffado"])

    const second = await store.get()
    expect(second[0]).not.toBe(first[0])
    expect(second[0].transcripts.map((t) => t.source).sort()).toEqual(["manual", "riffado"])
  })

  it("a removed transcript source is noticed", async () => {
    const f1 = fixture({ transcriptId: "t-1", source: "riffado" })
    const stamp1b = { ...f1.stamp, transcript_id: "t-2", source: "manual" }
    const meta1b = { ...f1.meta, source: "manual" }
    const { pool } = fakePool({
      stamp: [[f1.stamp, stamp1b], [f1.stamp]],
      metadata: [[f1.meta, meta1b], [f1.meta]],
    })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 0 })

    const first = await store.get()
    expect(first[0].transcripts.map((t) => t.source).sort()).toEqual(["manual", "riffado"])

    const second = await store.get()
    expect(second[0]).not.toBe(first[0])
    expect(second[0].transcripts.map((t) => t.source)).toEqual(["riffado"])
  })

  it("invalidate() forces a full rebuild even when nothing changed", async () => {
    const f = fixture()
    const { pool } = fakePool({ stamp: [[f.stamp]], metadata: [[f.meta], [f.meta]] })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 60000 })

    const first = await store.get()
    store.invalidate()
    const second = await store.get()

    expect(second[0]).not.toBe(first[0])
    expect(second[0]).toEqual(first[0]) // same content, different object
  })

  it("a legacy non-v1:-prefixed value does not crash, and a change to it is still reflected", async () => {
    const f1 = fixture({ filename: "Legacy Plaintext Title" })
    const f2 = fixture({ filename: "Legacy Plaintext Title, edited" })
    const { pool } = fakePool({ stamp: [[f1.stamp], [f2.stamp]], metadata: [[f1.meta], [f2.meta]] })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 0 })

    const first = await store.get()
    expect(first[0].title).toBe("Legacy Plaintext Title")

    const second = await store.get()
    expect(second[0]).not.toBe(first[0])
    expect(second[0].title).toBe("Legacy Plaintext Title, edited")
  })

  it("a legacy non-v1:-prefixed value is treated conservatively: always rebuilt, never silently reused, even when the value itself didn't change", async () => {
    const f = fixture({ filename: "Legacy Plaintext Title" })
    // The SAME stamp row both times (phase 1 would see the identical DB content) -- yet a
    // legacy field can never be verified unchanged from a prefix alone, so this must still
    // rebuild every time, not settle into "reused" the way a real v1: field would.
    const { pool } = fakePool({ stamp: [[f.stamp]], metadata: [[f.meta], [f.meta]] })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 0 })

    const first = await store.get()
    const second = await store.get()

    expect(second[0]).not.toBe(first[0])
    expect(second[0].title).toBe("Legacy Plaintext Title")
  })
})

describe("RecordingStore refresh() query shape", () => {
  it("phase 1's stamp query selects only short prefixes/flags, never the full ciphertext columns", async () => {
    const f = fixture()
    const { pool, calls } = fakePool({ stamp: [[f.stamp]], metadata: [[f.meta]] })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 60000 })
    await store.get()

    const stampCall = calls.find((c) => c.kind === "stamp")
    expect(stampCall).toBeDefined()
    expect(stampCall!.query).toMatch(/left\(r\.filename,\s*\d+\)/i)
    expect(stampCall!.query).toMatch(/left\(e\.summary,\s*\d+\)/i)
    // Not the whole column, unprefixed, anywhere in the select list.
    expect(stampCall!.query).not.toMatch(/(^|,)\s*r\.filename\s*(,|FROM)/im)
    expect(stampCall!.query).not.toMatch(/(^|,)\s*e\.summary\s*(,|FROM)/im)
    expect(stampCall!.query).not.toMatch(/e\.key_points::text\s*,\s*e\.key_points::text/i)
  })

  it("phase 2's metadata query never selects transcript text as a plain column, and is always scoped to specific ids", async () => {
    const f = fixture()
    const { pool, calls } = fakePool({ stamp: [[f.stamp]], metadata: [[f.meta]] })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 60000 })
    await store.get()

    const metadataCall = calls.find((c) => c.kind === "metadata")
    expect(metadataCall).toBeDefined()
    // t.text may appear inside function calls (length(t.text), left(t.text, 3) -- used only
    // to estimate a character count server-side) but never as its own selected column.
    expect(metadataCall!.query).not.toMatch(/(^|,)\s*t\.text\s*(,|FROM)/im)
    expect(metadataCall!.query).toMatch(/r\.id = ANY\(\$1\)/)
  })

  it("returns descriptors with textLength but no text property", async () => {
    const f = fixture()
    const { pool } = fakePool({ stamp: [[f.stamp]], metadata: [[f.meta]] })
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

describe("RecordingStore per-recording error isolation", () => {
  it("a recording with an undecryptable field (bad GCM tag) is skipped, not fatal to the refresh", async () => {
    const badFilename = corruptedSameIv(encryptForTest("Broken title"))
    const bad = fixture({ id: "rec-bad", filename: badFilename })
    const good = fixture({ id: "rec-good" })
    const { pool } = fakePool({
      stamp: [[bad.stamp, good.stamp]],
      metadata: [[bad.meta, good.meta]],
    })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 0 })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const recordings = await store.get()

    expect(recordings.map((r) => r.id)).toEqual(["rec-good"])
    const skipLine = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes("skipping recording rec-bad"))
    expect(skipLine).toBeDefined()
    expect(skipLine).not.toContain("Broken title")
    expect(skipLine).not.toContain(badFilename)

    errorSpy.mockRestore()
  })

  it("a recording with invalid JSON in key_points is skipped, not fatal to the refresh", async () => {
    const bad = fixture({
      id: "rec-bad-json",
      keyPoints: pgJsonbWrapper(encryptForTest("not valid json")),
    })
    const good = fixture({ id: "rec-good" })
    const { pool } = fakePool({
      stamp: [[bad.stamp, good.stamp]],
      metadata: [[bad.meta, good.meta]],
    })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 0 })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const recordings = await store.get()

    expect(recordings.map((r) => r.id)).toEqual(["rec-good"])
    expect(
      errorSpy.mock.calls.some((c) => String(c[0]).includes("skipping recording rec-bad-json")),
    ).toBe(true)

    errorSpy.mockRestore()
  })
})

describe("RecordingStore.getTranscripts() error isolation", () => {
  it("one undecryptable transcript row yields no text for that source, without throwing for the batch", async () => {
    const badText = corruptedSameIv(encryptForTest("secret transcript"))
    const { pool } = fakePool({
      transcripts: [
        { recording_id: "a", source: "riffado", text: badText },
        { recording_id: "b", source: "riffado", text: encryptForTest("text b") },
      ],
    })
    const store = new RecordingStore({ pool, encryptionKey: KEY, cacheTtlMs: 60000 })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const byId = await store.getTranscripts(["a", "b"])

    expect(byId.get("a")).toEqual([])
    expect(byId.get("b")![0].text).toBe("text b")
    expect(
      errorSpy.mock.calls.some((c) => String(c[0]).includes("skipping transcript for recording a")),
    ).toBe(true)

    errorSpy.mockRestore()
  })
})
