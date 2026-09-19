import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { registerRiffadoResources } from "../../../src/resources/index.js"
import type { RecordingStore } from "../../../src/riffado/store.js"
import type { Recording, TranscriptText } from "../../../src/riffado/types.js"

const FIXTURES: Recording[] = [
  {
    id: "rec-1",
    userId: "u1",
    title: "First recording",
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 60000,
    duration: "0:01:00",
    summary: "A short summary.",
    keyPoints: [],
    actionItems: [],
    transcripts: [{ source: "riffado", provider: "openai", model: "whisper-1", textLength: 11 }],
  },
]

const TRANSCRIPT_TEXTS = new Map<string, TranscriptText[]>([
  ["rec-1", [{ source: "riffado", text: "hello world" }]],
])

function fakeStore(recordings: Recording[]): RecordingStore {
  return {
    get: async () => recordings,
    getTranscripts: async (ids: string[]) => {
      const result = new Map<string, TranscriptText[]>()
      for (const id of ids) {
        result.set(id, TRANSCRIPT_TEXTS.get(id) ?? [])
      }
      return result
    },
  } as unknown as RecordingStore
}

describe("riffado resources", () => {
  let client: Client
  let server: McpServer

  beforeEach(async () => {
    server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { resources: {} } })
    registerRiffadoResources(server, fakeStore(FIXTURES))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  })

  afterEach(async () => {
    await client.close()
    await server.close()
  })

  it("lists the index resource", async () => {
    const result = await client.listResources()
    expect(result.resources.some((r) => r.uri === "riffado://index")).toBe(true)
  })

  it("reads the index as markdown containing the recording title", async () => {
    const result = await client.readResource({ uri: "riffado://index" })
    const text = (result.contents[0] as { text: string }).text
    expect(text).toContain("First recording")
  })

  it("reads one recording via the template URI", async () => {
    const result = await client.readResource({ uri: "riffado://recording/rec-1" })
    const text = (result.contents[0] as { text: string }).text
    expect(text).toContain("First recording")
    expect(text).toContain("hello world")
  })

  it("reports an unknown recording id without throwing", async () => {
    const result = await client.readResource({ uri: "riffado://recording/does-not-exist" })
    const text = (result.contents[0] as { text: string }).text
    expect(text).toContain("does-not-exist")
  })
})
