import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { registerRiffadoPrompts } from "../../../src/prompts/index.js"

describe("riffado_ask prompt", () => {
  let client: Client
  let server: McpServer

  beforeEach(async () => {
    server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { prompts: {} } })
    registerRiffadoPrompts(server)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  })

  afterEach(async () => {
    await client.close()
    await server.close()
  })

  it("is listed", async () => {
    const result = await client.listPrompts()
    expect(result.prompts.some((p) => p.name === "riffado_ask")).toBe(true)
  })

  it("embeds the question and the house citation rules", async () => {
    const result = await client.getPrompt({
      name: "riffado_ask",
      arguments: { question: "Was wurde vereinbart?" },
    })
    const text = (result.messages[0].content as { text: string }).text
    expect(text).toContain("Was wurde vereinbart?")
    expect(text).toContain("quote the decisive passage verbatim")
    expect(text).toContain("Speakers are")
    expect(text).toContain("Answer in the language of the question")
  })
})
