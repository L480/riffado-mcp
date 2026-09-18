import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { StdioTransportServer } from "../../../src/transports/stdio.js"

describe("StdioTransportServer", () => {
  it("connects the MCP server to a stdio transport on start", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: {} })
    const connectSpy = vi.spyOn(server, "connect").mockResolvedValue(undefined)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const transportServer = new StdioTransportServer(server)
    await transportServer.start()

    expect(connectSpy).toHaveBeenCalledTimes(1)
    // All stdio logging must go to stderr, never stdout (stdout is the
    // JSON-RPC channel) — confirm the startup message used console.error.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("stdio"))

    connectSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it("closes the MCP server on stop", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: {} })
    vi.spyOn(server, "connect").mockResolvedValue(undefined)
    const closeSpy = vi.spyOn(server, "close").mockResolvedValue(undefined)
    vi.spyOn(console, "error").mockImplementation(() => {})

    const transportServer = new StdioTransportServer(server)
    await transportServer.start()
    await transportServer.stop()

    expect(closeSpy).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })
})
