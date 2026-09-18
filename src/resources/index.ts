import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { RecordingStore } from "../riffado/store.js"
import { formatRecordingDetail, formatRecordingListItem } from "../riffado/format.js"

export function registerRiffadoResources(server: McpServer, store: RecordingStore): void {
  server.registerResource(
    "riffado-index",
    "riffado://index",
    {
      title: "Riffado recording index",
      description: "All recordings (newest first) as a markdown index.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const recordings = await store.get()
      const text = [
        `# Riffado recordings (${recordings.length})`,
        "",
        ...recordings.map((r) => formatRecordingListItem(r, true)),
      ].join("\n")
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] }
    },
  )

  server.registerResource(
    "riffado-recording",
    new ResourceTemplate("riffado://recording/{id}", {
      list: async () => {
        const recordings = await store.get()
        return {
          resources: recordings.map((r) => ({
            uri: `riffado://recording/${r.id}`,
            name: r.title,
            mimeType: "text/markdown",
          })),
        }
      },
    }),
    {
      title: "Riffado recording",
      description:
        "One recording in full: metadata, summary, key points, action items, transcript.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id
      const recordings = await store.get()
      const rec = recordings.find((r) => r.id === id)
      if (!rec) {
        return {
          contents: [
            { uri: uri.href, mimeType: "text/markdown", text: `No recording with id \`${id}\`.` },
          ],
        }
      }
      const transcript = rec.transcripts[0]
      const text = formatRecordingDetail(
        rec,
        transcript
          ? { source: transcript.source, text: transcript.text, truncated: false }
          : undefined,
      )
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] }
    },
  )
}
