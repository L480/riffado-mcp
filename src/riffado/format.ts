/** Pure formatting helpers shared by the store, tools and resources. No I/O. */
import type { Recording, ActionItemEntry } from "./types.js"
import type { SearchHit } from "./search.js"

/** Formats a millisecond duration as `H:MM:SS`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

/**
 * Flattens one `key_points`/`action_items` entry to a string. Mirrors
 * `bullets()` in `riffado_export.py`: an object's truthy values are joined
 * with " — "; anything else is stringified.
 */
export function flattenListItem(item: unknown): string {
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    return Object.values(item as Record<string, unknown>)
      .filter((v) => v !== undefined && v !== null && v !== "" && v !== false)
      .map((v) => String(v))
      .join(" — ")
  }
  return String(item)
}

/** Falls back to the recording id when the decrypted title is empty. */
export function titleOrFallback(title: string, id: string): string {
  return title.trim().length > 0 ? title : id
}

export interface Slice {
  text: string
  truncated: boolean
  nextOffset?: number
  remainingChars?: number
}

/**
 * Slices `text` starting at `offset` for at most `limitChars` characters.
 * When the slice doesn't reach the end, returns `nextOffset` + the count of
 * remaining characters so callers can page through long transcripts.
 */
export function sliceText(text: string, offset: number, limitChars: number): Slice {
  const start = Math.max(0, Math.min(offset, text.length))
  const end = Math.min(text.length, start + limitChars)
  const truncated = end < text.length
  return {
    text: text.slice(start, end),
    truncated,
    nextOffset: truncated ? end : undefined,
    remainingChars: truncated ? text.length - end : undefined,
  }
}

/** Single-line snippet of `text`, truncated at `maxChars` with an ellipsis. */
export function snippet(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  if (collapsed.length <= maxChars) {
    return collapsed
  }
  return collapsed.slice(0, maxChars).trimEnd() + "…"
}

/** One line for `riffado_list_recordings`: date, duration, title, sources. */
export function formatRecordingListItem(rec: Recording, includeSummary: boolean): string {
  const sources = rec.transcripts.map((t) => t.source).join(", ") || "no transcript"
  const link = rec.url ? ` — [open](${rec.url})` : ""
  const lines = [
    `- **${rec.title}** (\`${rec.id}\`) — ${rec.startedAt} · ${rec.duration} · transcripts: ${sources}${link}`,
  ]
  if (includeSummary && rec.summary) {
    lines.push(`  > ${snippet(rec.summary, 240)}`)
  }
  return lines.join("\n")
}

/** Markdown block for one `riffado_search` hit, with its ranked snippets. */
export function formatSearchHit(hit: SearchHit): string {
  const rec = hit.recording
  const link = rec.url ? ` — [open](${rec.url})` : ""
  const lines = [
    `### ${rec.title} (\`${rec.id}\`)`,
    `${rec.startedAt} · ${rec.duration} · ${hit.matchCount} match(es)${link}`,
    "",
  ]
  for (const s of hit.snippets) {
    lines.push(`> ${s}`, "")
  }
  return lines.join("\n").trimEnd()
}

/** Full detail markdown for `riffado_get_recording`. */
export function formatRecordingDetail(
  rec: Recording,
  transcript?: {
    source: string
    text: string
    truncated: boolean
    nextOffset?: number
    remainingChars?: number
  },
): string {
  const lines = [
    `# ${rec.title}`,
    "",
    `- id: \`${rec.id}\``,
    `- recorded: ${rec.startedAt}`,
    `- duration: ${rec.duration}`,
  ]
  if (rec.url) {
    lines.push(`- link: ${rec.url}`)
  }
  lines.push("")

  if (rec.summary) {
    lines.push("## Summary", "", rec.summary, "")
  }
  if (rec.keyPoints.length > 0) {
    lines.push("## Key points", "", ...rec.keyPoints.map((k) => `- ${k}`), "")
  }
  if (rec.actionItems.length > 0) {
    lines.push("## Action items", "", ...rec.actionItems.map((a) => `- ${a}`), "")
  }
  lines.push(
    `## Transcripts available`,
    "",
    rec.transcripts.length > 0
      ? rec.transcripts
          .map((t) => `- ${t.source} (${t.language ?? "lang?"}, ${t.provider}/${t.model})`)
          .join("\n")
      : "_none_",
    "",
  )

  if (transcript) {
    lines.push(`## Transcript (${transcript.source})`, "", transcript.text, "")
    if (transcript.truncated) {
      lines.push(
        `_Truncated — ${transcript.remainingChars} character(s) remaining, pass ` +
          `\`transcript_offset: ${transcript.nextOffset}\` to continue._`,
        "",
      )
    }
  }

  return lines.join("\n").trimEnd()
}

/** One line for `riffado_list_action_items`. */
export function formatActionItemEntry(entry: ActionItemEntry): string {
  return `- ${entry.text} — _${entry.recordingTitle}, ${entry.startedAt.slice(0, 10)}_ (\`${entry.recordingId}\`)`
}
