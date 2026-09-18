import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { registerRiffadoTools } from "../../../src/tools/riffado-tools.js"
import type { RecordingStore } from "../../../src/riffado/store.js"
import type { Recording } from "../../../src/riffado/types.js"

function fakeStore(recordings: Recording[]): RecordingStore {
  return { get: async () => recordings } as unknown as RecordingStore
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
      {
        source: "riffado",
        provider: "openai",
        model: "whisper-1",
        language: "de",
        text: "Wir sprechen heute über die Kita-Übergabe und die neue Erzieherin.",
      },
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
      {
        source: "riffado",
        provider: "openai",
        model: "whisper-1",
        language: "de",
        text: "Das Angebot für die Heizung liegt bei dreitausend Euro.",
      },
      {
        source: "manual",
        provider: "human",
        model: "n/a",
        language: "de",
        text: "Manuell nachgetragene Notizen zur Heizung.",
      },
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

  beforeEach(async () => {
    ;({ client, server } = await connect(fakeStore(FIXTURES)))
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
})

describe("riffado_search", () => {
  let client: Client
  let server: McpServer

  beforeEach(async () => {
    ;({ client, server } = await connect(fakeStore(FIXTURES)))
  })
  afterEach(async () => {
    await client.close()
    await server.close()
  })

  it("finds a German term in the transcript", async () => {
    const result = await client.callTool({
      name: "riffado_search",
      arguments: { query: "Erzieherin" },
    })
    const structured = result.structuredContent as { hits: { id: string }[] }
    expect(structured.hits.map((h) => h.id)).toContain("rec-3")
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
})

describe("riffado_get_recording", () => {
  let client: Client
  let server: McpServer

  beforeEach(async () => {
    ;({ client, server } = await connect(fakeStore(FIXTURES)))
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
    const { client, server } = await connect(fakeStore(FIXTURES))
    const result = await client.callTool({ name: "riffado_list_action_items", arguments: {} })
    const structured = result.structuredContent as { items: { recordingId: string }[] }
    expect(structured.items.some((i) => i.recordingId === "rec-3")).toBe(true)
    await client.close()
    await server.close()
  })
})

describe("riffado_stats", () => {
  it("computes counts and coverage gaps", async () => {
    const { client, server } = await connect(fakeStore(FIXTURES))
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
})
