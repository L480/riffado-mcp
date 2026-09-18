import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createRequire } from "module"
import type { RecordingStore } from "../riffado/store.js"
import { registerRiffadoTools } from "../tools/riffado-tools.js"
import { registerRiffadoResources } from "../resources/index.js"
import { registerRiffadoPrompts } from "../prompts/index.js"

// package.json isn't an ES module, and `import ... with { type: "json" }`
// couples us to a Node version; createRequire works the same on every
// supported Node without that coupling.
const require = createRequire(import.meta.url)
const pkg = require("../../package.json") as { name: string; version: string }

/** Builds one configured MCP server instance (tools + resources + prompts). */
export function createRiffadoServer(store: RecordingStore): McpServer {
  const server = new McpServer(
    { name: pkg.name, version: pkg.version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )
  registerRiffadoTools(server, store)
  registerRiffadoResources(server, store)
  registerRiffadoPrompts(server)
  return server
}
