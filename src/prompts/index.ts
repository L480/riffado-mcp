/**
 * `riffado_ask` carries over the answering rules from the local
 * `/riffado` slash command (`.claude/commands/riffado.md` §3 in agent-infra)
 * so a Claude client using this MCP server behaves the same way.
 */
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

const RULES = `Answer strictly from the Riffado recordings (transcripts, AI summaries, key
points, action items) via the riffado_* tools — never from general knowledge.

1. Find: start with riffado_list_recordings or riffado_search. Search terms have
   no stemming — try German *and* English variants, and names, before concluding
   there's no match.
2. Answer:
   - Cite date + title for every claim, and quote the decisive passage verbatim.
   - A transcript (what was said) beats an AI summary — if they conflict, say so.
   - Transcripts are ASR: names, numbers and dates may be misheard. Flag it when
     the answer hinges on one.
   - Speakers are "Speaker 1/2/..." unless named in the conversation — don't guess.
   - No hits: say so plainly and name the terms you searched. Never fill the gap
     from general knowledge.
   - Answer in the language of the question.`

export function registerRiffadoPrompts(server: McpServer): void {
  server.registerPrompt(
    "riffado_ask",
    {
      title: "Ask the Riffado archive",
      description:
        "Answer a question from the Riffado recordings, following the house citation rules.",
      argsSchema: { question: z.string().min(1) },
    },
    ({ question }) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: `${RULES}\n\nQuestion: ${question}` },
        },
      ],
    }),
  )
}
