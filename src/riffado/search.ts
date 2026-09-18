/**
 * In-memory search over decrypted recordings. Pure functions, no I/O — the
 * DB only ever holds ciphertext (see `docs/architecture.md`), so search has
 * to happen here, after decryption, not in SQL.
 *
 * No stemming: callers (tool descriptions, the `riffado_ask` prompt) are
 * told to pass German *and* English term variants themselves.
 */
import type { Recording } from "./types.js"

export type SearchScope = "all" | "transcript" | "summary"

export interface SearchOptions {
  scope: SearchScope
  contextChars: number
  maxSnippetsPerRecording?: number
}

export interface SearchHit {
  recording: Recording
  score: number
  matchCount: number
  snippets: string[]
}

export interface SearchResult {
  terms: string[]
  hits: SearchHit[]
}

interface NormalizedText {
  normalized: string
  /** normalized[i] came from original text at index map[i]. */
  map: number[]
}

/** Lowercases and strips diacritics (NFD, drop combining marks). */
export function normalize(text: string): string {
  return normalizeWithMap(text).normalized
}

function normalizeWithMap(text: string): NormalizedText {
  const map: number[] = []
  let normalized = ""
  for (let i = 0; i < text.length; i++) {
    const decomposed = text[i].normalize("NFD")
    for (const ch of decomposed) {
      if (isCombiningMark(ch)) {
        continue
      }
      normalized += ch.toLowerCase()
      map.push(i)
    }
  }
  return { normalized, map }
}

function isCombiningMark(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return code >= 0x0300 && code <= 0x036f
}

/** Splits a query into terms; a `"quoted phrase"` stays a single term. */
export function parseQueryTerms(query: string): string[] {
  const terms: string[] = []
  const re = /"([^"]+)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(query)) !== null) {
    const term = (m[1] ?? m[2] ?? "").trim()
    if (term) {
      terms.push(term)
    }
  }
  return terms
}

interface Field {
  weight: number
  text: string
}

function fieldsForRecording(recording: Recording, scope: SearchScope): Field[] {
  const fields: Field[] = []
  if (scope !== "transcript") {
    fields.push({ weight: 5, text: recording.title })
    if (recording.summary) {
      fields.push({ weight: 4, text: recording.summary })
    }
    if (recording.keyPoints.length > 0) {
      fields.push({ weight: 4, text: recording.keyPoints.join(" \n ") })
    }
    if (recording.actionItems.length > 0) {
      fields.push({ weight: 4, text: recording.actionItems.join(" \n ") })
    }
  }
  if (scope !== "summary") {
    for (const t of recording.transcripts) {
      fields.push({ weight: 1, text: t.text })
    }
  }
  return fields
}

interface Occurrence {
  fieldIndex: number
  start: number
  end: number
}

function findOccurrences(field: Field, normalizedTerm: string): Occurrence[] {
  if (!normalizedTerm || !field.text) {
    return []
  }
  const { normalized, map } = normalizeWithMap(field.text)
  const occurrences: Occurrence[] = []
  let from = 0
  for (;;) {
    const idx = normalized.indexOf(normalizedTerm, from)
    if (idx === -1) {
      break
    }
    const start = map[idx]
    const end = map[idx + normalizedTerm.length - 1] + 1
    occurrences.push({ fieldIndex: 0, start, end })
    from = idx + Math.max(1, normalizedTerm.length)
  }
  return occurrences
}

interface Window {
  fieldOrdinal: number
  weight: number
  start: number
  end: number
}

function buildSnippets(
  fields: Field[],
  occurrencesByField: Occurrence[][],
  contextChars: number,
  maxSnippets: number,
): string[] {
  const windows: Window[] = []
  fields.forEach((field, fieldOrdinal) => {
    const occurrences = occurrencesByField[fieldOrdinal]
    if (!occurrences || occurrences.length === 0) {
      return
    }
    const merged: Window[] = []
    for (const occ of occurrences.sort((a, b) => a.start - b.start)) {
      const start = Math.max(0, occ.start - contextChars)
      const end = Math.min(field.text.length, occ.end + contextChars)
      const last = merged[merged.length - 1]
      if (last && start <= last.end) {
        last.end = Math.max(last.end, end)
      } else {
        merged.push({ fieldOrdinal, weight: field.weight, start, end })
      }
    }
    windows.push(...merged)
  })

  windows.sort((a, b) => b.weight - a.weight || a.start - b.start)

  const out: string[] = []
  const seen = new Set<string>()
  for (const w of windows) {
    if (out.length >= maxSnippets) {
      break
    }
    const field = fields[w.fieldOrdinal]
    const key = `${w.fieldOrdinal}:${w.start}:${w.end}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const prefix = w.start > 0 ? "…" : ""
    const suffix = w.end < field.text.length ? "…" : ""
    out.push(`${prefix}${field.text.slice(w.start, w.end).trim()}${suffix}`)
  }
  return out
}

/** Searches decrypted recordings, ranked by term coverage then weighted hits. */
export function searchRecordings(
  recordings: Recording[],
  query: string,
  options: SearchOptions,
): SearchResult {
  const terms = parseQueryTerms(query)
  const normalizedTerms = terms.map((t) => normalize(t))
  const maxSnippets = options.maxSnippetsPerRecording ?? 3

  const hits: SearchHit[] = []
  for (const recording of recordings) {
    const fields = fieldsForRecording(recording, options.scope)
    if (fields.length === 0 || normalizedTerms.length === 0) {
      continue
    }

    const occurrencesByField: Occurrence[][] = fields.map(() => [])
    const matchedTerms = new Set<string>()
    let weightedHits = 0
    let matchCount = 0

    normalizedTerms.forEach((normTerm) => {
      fields.forEach((field, fieldOrdinal) => {
        const occurrences = findOccurrences(field, normTerm)
        if (occurrences.length > 0) {
          matchedTerms.add(normTerm)
          matchCount += occurrences.length
          weightedHits += occurrences.length * field.weight
          occurrencesByField[fieldOrdinal].push(...occurrences)
        }
      })
    })

    if (matchedTerms.size === 0) {
      continue
    }

    const coverage = matchedTerms.size / normalizedTerms.length
    const score = coverage * 1000 + weightedHits

    hits.push({
      recording,
      score,
      matchCount,
      snippets: buildSnippets(fields, occurrencesByField, options.contextChars, maxSnippets),
    })
  }

  hits.sort((a, b) => b.score - a.score)
  return { terms, hits }
}
