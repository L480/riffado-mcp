/**
 * The five read-only Riffado tools. Every tool is `readOnlyHint: true`,
 * returns `content: [{ type: "text", text: <markdown> }]` plus
 * `structuredContent` with the same data as JSON, and never exposes audio,
 * storage paths, credentials or other users' rows.
 */
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { RecordingStore } from "../riffado/store.js"
import {
  computeCandidateK,
  finalizeSearch,
  normalize,
  parseQueryTerms,
  rankByCheapFields,
} from "../riffado/search.js"
import {
  formatActionItemEntry,
  formatDuration,
  formatRecordingDetail,
  formatRecordingListItem,
  formatSearchHit,
  sliceText,
  snippet,
} from "../riffado/format.js"
import type { ActionItemEntry, Recording, TranscriptText } from "../riffado/types.js"

const SEARCH_TERM_HINT =
  "No stemming is applied — pass German *and* English variants of a term " +
  "(and names) to catch both, the way the /riffado slash command does."

function normalizeDateBound(value: string | undefined, endOfDay: boolean): string | undefined {
  if (!value) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return endOfDay ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`
  }
  return value
}

function inRange(startedAt: string, from?: string, to?: string): boolean {
  const lo = normalizeDateBound(from, false)
  const hi = normalizeDateBound(to, true)
  if (lo && startedAt < lo) return false
  if (hi && startedAt > hi) return false
  return true
}

function filterByRange(recordings: Recording[], from?: string, to?: string): Recording[] {
  return recordings.filter((r) => inRange(r.startedAt, from, to))
}

function median(sortedValues: number[]): number {
  const n = sortedValues.length
  if (n === 0) return 0
  const mid = Math.floor(n / 2)
  return n % 2 === 1 ? sortedValues[mid] : (sortedValues[mid - 1] + sortedValues[mid]) / 2
}

export function registerRiffadoTools(server: McpServer, store: RecordingStore): void {
  server.registerTool(
    "riffado_list_recordings",
    {
      title: "List Riffado recordings",
      description:
        "Lists Riffado voice recordings (newest first by default), with title, date, duration, " +
        "available transcript sources and an optional summary snippet.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(20).describe("Max rows to return (1-200)."),
        offset: z.number().int().min(0).default(0).describe("Rows to skip, for paging."),
        from: z.string().optional().describe("ISO date (YYYY-MM-DD) lower bound on start_time."),
        to: z.string().optional().describe("ISO date (YYYY-MM-DD) upper bound on start_time."),
        order: z.enum(["newest", "oldest"]).default("newest"),
        include_summary: z
          .boolean()
          .default(true)
          .describe("Include a 240-char summary snippet per row."),
      },
    },
    async (args) => {
      const recordings = await store.get()
      const filtered = filterByRange(recordings, args.from, args.to)
      const ordered = args.order === "oldest" ? [...filtered].reverse() : filtered
      const page = ordered.slice(args.offset, args.offset + args.limit)
      const total = filtered.length
      const hasMore = args.offset + page.length < total

      const header = `${total} recording(s)${args.from || args.to ? " in range" : ""}, showing ${page.length}${hasMore ? " (more available)" : ""}.`
      const text = [
        header,
        "",
        ...page.map((r) => formatRecordingListItem(r, args.include_summary)),
      ].join("\n")

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          total,
          hasMore,
          offset: args.offset,
          limit: args.limit,
          recordings: page.map((r) => ({
            id: r.id,
            title: r.title,
            startedAt: r.startedAt,
            durationMs: r.durationMs,
            duration: r.duration,
            transcriptSources: r.transcripts.map((t) => t.source),
            summary: args.include_summary && r.summary ? snippet(r.summary, 240) : undefined,
            url: r.url,
          })),
        },
      }
    },
  )

  server.registerTool(
    "riffado_search",
    {
      title: "Search Riffado recordings",
      description:
        `Search over titles, summaries, key points, action items and transcripts (the database ` +
        `only holds ciphertext, so this runs in-process, not in SQL). Two-stage: ranks the whole ` +
        `corpus on titles/summaries/key points/action items first, then scans transcript text ` +
        `only for the top-ranked candidates (scope: "all", the default) — so a no-hit result can ` +
        `be a narrowing artifact, not proof of absence. Pass deep: true to scan every recording's ` +
        `transcript instead (slow, cost scales with corpus size — combine with from/to). Quote a ` +
        `phrase to search it as one term. ${SEARCH_TERM_HINT}`,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        query: z.string().min(1).describe('Search terms; "quoted phrases" match literally.'),
        scope: z.enum(["all", "transcript", "summary"]).default("all"),
        limit: z.number().int().min(1).max(50).default(10),
        from: z.string().optional().describe("ISO date (YYYY-MM-DD) lower bound on start_time."),
        to: z.string().optional().describe("ISO date (YYYY-MM-DD) upper bound on start_time."),
        context_chars: z
          .number()
          .int()
          .min(50)
          .max(2000)
          .default(300)
          .describe("Snippet context window."),
        deep: z
          .boolean()
          .default(false)
          .describe(
            "Slow — scans every recording's transcript that passes the date filter, instead of " +
              "only the top-ranked candidates. Cost scales with corpus size; combine with from/to " +
              "to bound it. Use when a term might appear only in a transcript and in no " +
              "title/summary/key point/action item.",
          ),
      },
    },
    async (args) => {
      const recordings = await store.get()
      const filtered = filterByRange(recordings, args.from, args.to)
      const terms = parseQueryTerms(args.query)
      const normalizedTerms = terms.map((t) => normalize(t))

      const normalizedFieldsById = await store.getNormalizedFields()
      const ranked = rankByCheapFields(filtered, normalizedFieldsById, normalizedTerms)

      let candidateIds = new Set<string>()
      let transcriptsById = new Map<string, TranscriptText[]>()
      let candidateCount = 0

      if (args.scope !== "summary" && normalizedTerms.length > 0) {
        const k = computeCandidateK(args.limit)
        const candidateRecordings = args.deep
          ? filtered
          : ranked.slice(0, k).map((c) => c.recording)
        candidateCount = candidateRecordings.length
        candidateIds = new Set(candidateRecordings.map((r) => r.id))
        transcriptsById = await store.getTranscripts(candidateRecordings.map((r) => r.id))
      }

      const { hits } = finalizeSearch(
        ranked,
        terms,
        normalizedTerms,
        args.scope,
        candidateIds,
        transcriptsById,
        { contextChars: args.context_chars, limit: args.limit },
      )
      const limited = hits.slice(0, args.limit)
      const termsLabel = terms.map((t) => `"${t}"`).join(", ")

      const narrowingNote =
        args.scope !== "summary" && !args.deep
          ? ` Transcript text was scanned only for the top ${candidateCount} candidate(s), ranked ` +
            `by title/summary/key-point/action-item match — pass deep: true to scan every ` +
            `recording's transcript instead (slower, scales with corpus size); a no-hit result ` +
            `here may be a narrowing artifact, not proof of absence.`
          : ""

      if (limited.length === 0) {
        const text =
          `No matches for ${termsLabel} (scope: ${args.scope}` +
          `${args.from || args.to ? ", date-filtered" : ""}).${narrowingNote} ` +
          `Report honestly that nothing was found — don't answer from general knowledge.`
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { terms, total: 0, hits: [] },
        }
      }

      const text = [
        `${hits.length} recording(s) matched ${termsLabel} (scope: ${args.scope}), showing ${limited.length}.${narrowingNote}`,
        "",
        ...limited.map(formatSearchHit),
      ].join("\n\n")

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          terms,
          total: hits.length,
          hits: limited.map((h) => ({
            id: h.recording.id,
            title: h.recording.title,
            startedAt: h.recording.startedAt,
            duration: h.recording.duration,
            matchCount: h.matchCount,
            score: h.score,
            snippets: h.snippets,
            url: h.recording.url,
          })),
        },
      }
    },
  )

  server.registerTool(
    "riffado_get_recording",
    {
      title: "Get a Riffado recording",
      description:
        "Full detail for one recording: metadata, summary, key points, action items and a " +
        "(pageable) transcript slice. When multiple transcript sources exist, pick one with " +
        "transcript_source; otherwise the first is used.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        id: z.string().min(1),
        include_transcript: z.boolean().default(true),
        transcript_source: z.string().optional(),
        transcript_offset: z.number().int().min(0).default(0),
        transcript_limit_chars: z.number().int().min(1000).max(100000).default(20000),
      },
    },
    async (args) => {
      const recordings = await store.get()
      const rec = recordings.find((r) => r.id === args.id)
      if (!rec) {
        return {
          content: [{ type: "text" as const, text: `No recording with id \`${args.id}\`.` }],
          isError: true,
        }
      }

      let transcriptBlock:
        | {
            source: string
            text: string
            truncated: boolean
            nextOffset?: number
            remainingChars?: number
          }
        | undefined
      let unavailableNote = ""

      if (args.include_transcript && rec.transcripts.length > 0) {
        let chosen = rec.transcripts[0]
        if (args.transcript_source) {
          const found = rec.transcripts.find((t) => t.source === args.transcript_source)
          if (!found) {
            unavailableNote = `\n\n_No transcript with source \`${args.transcript_source}\`. Available: ${rec.transcripts.map((t) => t.source).join(", ")}._`
          } else {
            chosen = found
          }
        }
        if (!unavailableNote) {
          const textsBySource = (await store.getTranscripts([rec.id])).get(rec.id) ?? []
          const fullText = textsBySource.find((t) => t.source === chosen.source)?.text ?? ""
          const slice = sliceText(fullText, args.transcript_offset, args.transcript_limit_chars)
          transcriptBlock = {
            source: chosen.source,
            text: slice.text,
            truncated: slice.truncated,
            nextOffset: slice.nextOffset,
            remainingChars: slice.remainingChars,
          }
        }
      }

      const text = formatRecordingDetail(rec, transcriptBlock) + unavailableNote

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          id: rec.id,
          title: rec.title,
          startedAt: rec.startedAt,
          durationMs: rec.durationMs,
          duration: rec.duration,
          summary: rec.summary,
          keyPoints: rec.keyPoints,
          actionItems: rec.actionItems,
          transcriptSources: rec.transcripts.map((t) => t.source),
          transcript: transcriptBlock,
          url: rec.url,
        },
      }
    },
  )

  server.registerTool(
    "riffado_list_action_items",
    {
      title: "List Riffado action items",
      description:
        "Flattened action items across recordings, each tagged with its source recording.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        from: z.string().optional().describe("ISO date (YYYY-MM-DD) lower bound on start_time."),
        to: z.string().optional().describe("ISO date (YYYY-MM-DD) upper bound on start_time."),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async (args) => {
      const recordings = await store.get()
      const filtered = filterByRange(recordings, args.from, args.to)
      const entries: ActionItemEntry[] = []
      outer: for (const r of filtered) {
        for (const item of r.actionItems) {
          entries.push({
            text: item,
            recordingId: r.id,
            recordingTitle: r.title,
            startedAt: r.startedAt,
          })
          if (entries.length >= args.limit) break outer
        }
      }

      const text =
        entries.length === 0
          ? "No action items found."
          : entries.map(formatActionItemEntry).join("\n")

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { total: entries.length, items: entries },
      }
    },
  )

  server.registerTool(
    "riffado_stats",
    {
      title: "Riffado stats",
      description:
        "Aggregate stats: recording count, total/median duration, first/last recording date, " +
        "transcripts per source/provider, and how many recordings lack a transcript or AI summary.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const recordings = await store.get()
      const count = recordings.length
      const durations = recordings.map((r) => r.durationMs).sort((a, b) => a - b)
      const totalMs = durations.reduce((a, b) => a + b, 0)
      const medianMs = median(durations)

      const byStart = [...recordings].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      const first = byStart[0]?.startedAt
      const last = byStart[byStart.length - 1]?.startedAt

      const perSource = new Map<string, number>()
      const perProvider = new Map<string, number>()
      let withoutTranscript = 0
      let withoutSummary = 0
      for (const r of recordings) {
        if (r.transcripts.length === 0) withoutTranscript++
        if (!r.summary) withoutSummary++
        for (const t of r.transcripts) {
          perSource.set(t.source, (perSource.get(t.source) ?? 0) + 1)
          const provider = t.provider || "unknown"
          perProvider.set(provider, (perProvider.get(provider) ?? 0) + 1)
        }
      }

      const text = [
        "# Riffado stats",
        "",
        `- recordings: ${count}`,
        `- total duration: ${formatDuration(totalMs)}`,
        `- median duration: ${formatDuration(medianMs)}`,
        `- first recording: ${first ?? "n/a"}`,
        `- last recording: ${last ?? "n/a"}`,
        `- without transcript: ${withoutTranscript}`,
        `- without AI summary: ${withoutSummary}`,
        "",
        "## Transcripts per source",
        ...(perSource.size > 0
          ? [...perSource.entries()].map(([k, v]) => `- ${k}: ${v}`)
          : ["_none_"]),
        "",
        "## Transcripts per provider",
        ...(perProvider.size > 0
          ? [...perProvider.entries()].map(([k, v]) => `- ${k}: ${v}`)
          : ["_none_"]),
      ].join("\n")

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          count,
          totalDurationMs: totalMs,
          medianDurationMs: medianMs,
          firstRecordingAt: first,
          lastRecordingAt: last,
          withoutTranscript,
          withoutSummary,
          perSource: Object.fromEntries(perSource),
          perProvider: Object.fromEntries(perProvider),
        },
      }
    },
  )
}
