import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerRiffadoTools } from "../../../src/tools/riffado-tools.js"
import { computeCandidateK, normalizedCheapFieldsFor } from "../../../src/riffado/search.js"
import type { RecordingStore } from "../../../src/riffado/store.js"
import type { Recording, TranscriptText } from "../../../src/riffado/types.js"

function fakeStore(
  recordings: Recording[],
  transcriptTexts: Map<string, TranscriptText[]> = new Map(),
): RecordingStore & { getTranscripts: ReturnType<typeof vi.fn> } {
  const normalizedFieldsById = new Map(recordings.map((r) => [r.id, normalizedCheapFieldsFor(r)]))
  const getTranscripts = vi.fn(async (ids: string[]) => {
    const result = new Map<string, TranscriptText[]>()
    for (const id of ids) {
      result.set(id, transcriptTexts.get(id) ?? [])
    }
    return result
  })
  return {
    get: async () => recordings,
    getNormalizedFields: async () => normalizedFieldsById,
    getTranscripts,
  } as unknown as RecordingStore & { getTranscripts: ReturnType<typeof vi.fn> }
}

const FIXTURES: Recording[] = [
  {
    id: "rec-3",
    userId: "u1",
    title: "Kita Übergabe",
    startedAt: "2026-09-15T08:00:00.000Z",
    durationMs: 754_000,
    duration: "0:12:34",
    summary: "Besprochen wurde die Kita-Übergabe und der Wechsel der Erzieherin.",
    keyPoints: ["Neue Erzieherin ab Oktober", "Eingewöhnung startet Montag"],
    actionItems: ["Nico — Formular unterschreiben"],
    transcripts: [
      { source: "riffado", provider: "openai", model: "whisper-1", language: "de", textLength: 67 },
    ],
    url: "https://riffado.example.com/recordings/rec-3",
  },
  {
    id: "rec-2",
    userId: "u1",
    title: "Heizung Angebot",
    startedAt: "2026-08-01T09:00:00.000Z",
    durationMs: 1_800_000,
    duration: "0:30:00",
    summary: "Angebot für die neue Heizung besprochen, Pumpentausch nötig.",
    keyPoints: ["Pumpentausch notwendig"],
    actionItems: [],
    transcripts: [
      { source: "riffado", provider: "openai", model: "whisper-1", language: "de", textLength: 56 },
      { source: "manual", provider: "human", model: "n/a", language: "de", textLength: 42 },
    ],
  },
  {
    id: "rec-1",
    userId: "u1",
    title: "",
    startedAt: "2026-01-10T07:00:00.000Z",
    durationMs: 0,
    duration: "0:00:00",
    keyPoints: [],
    actionItems: [],
    transcripts: [],
  },
]
// keyPoints/actionItems are already flattened to strings by the store, so
// fixtures here use plain strings too.

const TRANSCRIPT_TEXTS = new Map<string, TranscriptText[]>([
  [
    "rec-3",
    [
      {
        source: "riffado",
        text: "Wir sprechen heute über die Kita-Übergabe und die neue Erzieherin.",
      },
    ],
  ],
  [
    "rec-2",
    [
      { source: "riffado", text: "Das Angebot für die Heizung liegt bei dreitausend Euro." },
      { source: "manual", text: "Manuell nachgetragene Notizen zur Heizung." },
    ],
  ],
])

async function connect(store: RecordingStore) {
  const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } })
  registerRiffadoTools(server, store)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { client, server }
}

describe("riffado_list_recordings", () => {
  let client: Client
  let server: McpServer
  let store: ReturnType<typeof fakeStore>

  beforeEach(async () => {
    store = fakeStore(FIXTURES)
    ;({ client, server } = await connect(store))
  })
  afterEach(async () => {
    await client.close()
    await server.close()
  })

  it("lists newest first by default", async () => {
    const result = await client.callTool({ name: "riffado_list_recordings", arguments: {} })
    const structured = result.structuredContent as { recordings: { id: string }[]; total: number }
    expect(structured.total).toBe(3)
    expect(structured.recordings.map((r) => r.id)).toEqual(["rec-3", "rec-2", "rec-1"])
  })

  it("orders oldest first when asked", async () => {
    const result = await client.callTool({
      name: "riffado_list_recordings",
      arguments: { order: "oldest" },
    })
    const structured = result.structuredContent as { recordings: { id: string }[] }
    expect(structured.recordings.map((r) => r.id)).toEqual(["rec-1", "rec-2", "rec-3"])
  })

  it("respects limit/offset and reports hasMore", async () => {
    const result = await client.callTool({
      name: "riffado_list_recordings",
      arguments: { limit: 1, offset: 0 },
    })
    const structured = result.structuredContent as {
      hasMore: boolean
      recordings: { id: string }[]
    }
    expect(structured.recordings).toHaveLength(1)
    expect(structured.hasMore).toBe(true)
  })

  it("filters by date range", async () => {
    const result = await client.callTool({
      name: "riffado_list_recordings",
      arguments: { from: "2026-08-01", to: "2026-09-30" },
    })
    const structured = result.structuredContent as { recordings: { id: string }[]; total: number }
    expect(structured.total).toBe(2)
    expect(structured.recordings.map((r) => r.id).sort()).toEqual(["rec-2", "rec-3"])
  })

  it("falls back to the id for an empty title", async () => {
    const result = await client.callTool({ name: "riffado_list_recordings", arguments: {} })
    const text = (result.content as { type: string; text: string }[])[0].text
    expect(text).toContain("rec-1")
  })

  it("never calls getTranscripts -- metadata only", async () => {
    await client.callTool({ name: "riffado_list_recordings", arguments: {} })
    expect(store.getTranscripts).not.toHaveBeenCalled()
  })
})

describe("riffado_search", () => {
  let client: Client
  let server: McpServer
  let store: ReturnType<typeof fakeStore>

  beforeEach(async () => {
    store = fakeStore(FIXTURES, TRANSCRIPT_TEXTS)
    ;({ client, server } = await connect(store))
  })
  afterEach(async () => {
    await client.close()
    await server.close()
  })

  it("finds a German term that is only in the transcript (two-stage, small corpus is fully candidate)", async () => {
    const result = await client.callTool({
      name: "riffado_search",
      arguments: { query: "Erzieherin" },
    })
    const structured = result.structuredContent as { hits: { id: string }[] }
    expect(structured.hits.map((h) => h.id)).toContain("rec-3")
  })

  it("accepts a query at the length cap and rejects one over it", async () => {
    const atCap = await client.callTool({
      name: "riffado_search",
      arguments: { query: "a".repeat(500) },
    })
    expect(atCap.isError).toBeFalsy()

    const over = await client
      .callTool({ name: "riffado_search", arguments: { query: "a".repeat(501) } })
      .then(
        (r) => r.isError === true,
        () => true,
      )
    expect(over).toBe(true)
  })

  it("reports the searched terms honestly when nothing matches", async () => {
    const result = await client.callTool({
      name: "riffado_search",
      arguments: { query: "nonexistentterm" },
    })
    const text = (result.content as { type: string; text: string }[])[0].text
    expect(text).toContain("nonexistentterm")
    expect(text.toLowerCase()).toContain("no matches")
    const structured = result.structuredContent as { hits: unknown[] }
    expect(structured.hits).toEqual([])
  })

  it("respects scope: summary", async () => {
    const result = await client.callTool({
      name: "riffado_search",
      arguments: { query: "Angebot", scope: "summary" },
    })
    const structured = result.structuredContent as { hits: { id: string }[] }
    expect(structured.hits.map((h) => h.id)).toEqual(["rec-2"])
  })

  it("scope: summary never fetches transcripts", async () => {
    await client.callTool({
      name: "riffado_search",
      arguments: { query: "Angebot", scope: "summary" },
    })
    expect(store.getTranscripts).not.toHaveBeenCalled()
  })

  it("scope: all fetches transcripts only for the stage-1 candidate set", async () => {
    await client.callTool({ name: "riffado_search", arguments: { query: "Angebot" } })
    expect(store.getTranscripts).toHaveBeenCalledTimes(1)
  })

  it("default response notes the recall narrowing when deep is false", async () => {
    const result = await client.callTool({
      name: "riffado_search",
      arguments: { query: "Erzieherin" },
    })
    const text = (result.content as { type: string; text: string }[])[0].text
    expect(text.toLowerCase()).toContain("deep: true")
  })

  it("deep: true omits the narrowing note", async () => {
    const result = await client.callTool({
      name: "riffado_search",
      arguments: { query: "Erzieherin", deep: true },
    })
    const text = (result.content as { type: string; text: string }[])[0].text
    expect(text.toLowerCase()).not.toContain("deep: true")
  })
})

describe("riffado_search: deep vs. shallow candidate narrowing", () => {
  // K = computeCandidateK(limit); with a corpus larger than K, some recordings never
  // become stage-1 candidates when their cheap fields don't match anything, so their
  // transcripts are only scanned under deep: true.
  const limit = 5
  const k = computeCandidateK(limit)
  const filler: Recording[] = Array.from({ length: k }, (_, i) => ({
    id: `filler-${i}`,
    userId: "u1",
    title: "Filler recording",
    startedAt: `2026-01-${String((i % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
    durationMs: 1000,
    duration: "0:00:01",
    keyPoints: [],
    actionItems: [],
    transcripts: [{ source: "riffado", provider: "p", model: "m", textLength: 20 }],
  }))
  const needle: Recording = {
    id: "needle",
    userId: "u1",
    title: "Also filler",
    startedAt: "2025-01-01T00:00:00.000Z",
    durationMs: 1000,
    duration: "0:00:01",
    keyPoints: [],
    actionItems: [],
    transcripts: [{ source: "riffado", provider: "p", model: "m", textLength: 40 }],
  }
  const corpus = [...filler, needle] // needle ranks last: filler count == K, all tied at score 0

  const transcriptTexts = new Map<string, TranscriptText[]>([
    ...filler.map((r): [string, TranscriptText[]] => [
      r.id,
      [{ source: "riffado", text: "nothing interesting here" }],
    ]),
    ["needle", [{ source: "riffado", text: "the term zzzuniqueneedle is right here" }]],
  ])

  it("deep: false does not find a term that is only in a non-candidate's transcript", async () => {
    const store = fakeStore(corpus, transcriptTexts)
    const { client, server } = await connect(store)
    const result = await client.callTool({
      name: "riffado_search",
      arguments: { query: "zzzuniqueneedle", limit },
    })
    const structured = result.structuredContent as { hits: unknown[] }
    expect(structured.hits).toEqual([])
    await client.close()
    await server.close()
  })

  it("deep: true finds it", async () => {
    const store = fakeStore(corpus, transcriptTexts)
    const { client, server } = await connect(store)
    const result = await client.callTool({
      name: "riffado_search",
      arguments: { query: "zzzuniqueneedle", limit, deep: true },
    })
    const structured = result.structuredContent as { hits: { id: string }[] }
    expect(structured.hits.map((h) => h.id)).toEqual(["needle"])
    await client.close()
    await server.close()
  })
})

describe("riffado_get_recording", () => {
  let client: Client
  let server: McpServer
  let store: ReturnType<typeof fakeStore>

  beforeEach(async () => {
    store = fakeStore(FIXTURES, TRANSCRIPT_TEXTS)
    ;({ client, server } = await connect(store))
  })
  afterEach(async () => {
    await client.close()
    await server.close()
  })

  it("returns full detail for a known id", async () => {
    const result = await client.callTool({
      name: "riffado_get_recording",
      arguments: { id: "rec-3" },
    })
    const structured = result.structuredContent as { id: string; summary: string }
    expect(structured.id).toBe("rec-3")
    expect(structured.summary).toContain("Kita-Übergabe")
  })

  it("fetches the transcript on demand, for that one recording only", async () => {
    await client.callTool({ name: "riffado_get_recording", arguments: { id: "rec-3" } })
    expect(store.getTranscripts).toHaveBeenCalledTimes(1)
    expect(store.getTranscripts).toHaveBeenCalledWith(["rec-3"])
  })

  it("is an error result for an unknown id", async () => {
    const result = await client.callTool({
      name: "riffado_get_recording",
      arguments: { id: "nope" },
    })
    expect(result.isError).toBe(true)
  })

  it("picks a specific transcript_source when given", async () => {
    const result = await client.callTool({
      name: "riffado_get_recording",
      arguments: { id: "rec-2", transcript_source: "manual" },
    })
    const structured = result.structuredContent as { transcript?: { source: string; text: string } }
    expect(structured.transcript?.source).toBe("manual")
    expect(structured.transcript?.text).toContain("Manuell")
  })

  it("notes an unavailable transcript_source", async () => {
    const result = await client.callTool({
      name: "riffado_get_recording",
      arguments: { id: "rec-2", transcript_source: "does-not-exist" },
    })
    const text = (result.content as { type: string; text: string }[])[0].text
    expect(text).toContain("does-not-exist")
  })

  it("pages a long transcript via transcript_offset/transcript_limit_chars", async () => {
    const result = await client.callTool({
      name: "riffado_get_recording",
      arguments: { id: "rec-2", transcript_source: "riffado", transcript_limit_chars: 1000 },
    })
    const structured = result.structuredContent as { transcript?: { truncated: boolean } }
    expect(structured.transcript?.truncated).toBe(false)
  })
})

describe("riffado_list_action_items", () => {
  it("flattens action items with their source recording", async () => {
    const store = fakeStore(FIXTURES)
    const { client, server } = await connect(store)
    const result = await client.callTool({ name: "riffado_list_action_items", arguments: {} })
    const structured = result.structuredContent as { items: { recordingId: string }[] }
    expect(structured.items.some((i) => i.recordingId === "rec-3")).toBe(true)
    await client.close()
    await server.close()
  })

  it("never calls getTranscripts -- metadata only", async () => {
    const store = fakeStore(FIXTURES)
    const { client, server } = await connect(store)
    await client.callTool({ name: "riffado_list_action_items", arguments: {} })
    expect(store.getTranscripts).not.toHaveBeenCalled()
    await client.close()
    await server.close()
  })
})

describe("riffado_stats", () => {
  it("computes counts and coverage gaps from descriptors", async () => {
    const store = fakeStore(FIXTURES)
    const { client, server } = await connect(store)
    const result = await client.callTool({ name: "riffado_stats", arguments: {} })
    const structured = result.structuredContent as {
      count: number
      withoutTranscript: number
      withoutSummary: number
    }
    expect(structured.count).toBe(3)
    expect(structured.withoutTranscript).toBe(1)
    expect(structured.withoutSummary).toBe(1)
    await client.close()
    await server.close()
  })

  it("never calls getTranscripts -- metadata only", async () => {
    const store = fakeStore(FIXTURES)
    const { client, server } = await connect(store)
    await client.callTool({ name: "riffado_stats", arguments: {} })
    expect(store.getTranscripts).not.toHaveBeenCalled()
    await client.close()
    await server.close()
  })
})
