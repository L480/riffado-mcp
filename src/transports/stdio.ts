import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { RiffadoTransportServer } from "./base.js"

/** Plain stdio transport for Claude Code running locally. All logging must
 * go to stderr — stdout is the JSON-RPC protocol channel. */
export class StdioTransportServer implements RiffadoTransportServer {
  private transport?: StdioServerTransport

  constructor(private readonly server: McpServer) {}

  async start(): Promise<void> {
    this.transport = new StdioServerTransport()
    await this.server.connect(this.transport)
    console.error("riffado-mcp running on stdio")
  }

  async stop(): Promise<void> {
    await this.server.close()
  }
}
