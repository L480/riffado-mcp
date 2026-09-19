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
  /**
   * Perf hint only, doesn't change results: offset maps + snippets are only
   * built for the top `limit` ranked hits (the rest come back with `snippets: []`,
   * since callers slice to this same limit before rendering). Omit to build
   * for every hit, as before.
   */
  limit?: number
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

/**
 * Same normalization as `normalizeWithMap`, without the per-character offset
 * map — used during scanning, where only the normalized string is needed.
 * The map is only worth paying for later, for the fields/hits that survive
 * ranking (see `translateOccurrences`).
 */
function normalizeOnly(text: string): string {
  let normalized = ""
  for (let i = 0; i < text.length; i++) {
    const decomposed = text[i].normalize("NFD")
    for (const ch of decomposed) {
      if (isCombiningMark(ch)) {
        continue
      }
      normalized += ch.toLowerCase()
    }
  }
  return normalized
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

/** An occurrence in normalized-string space, before translation back to original offsets. */
interface NormOccurrence {
  start: number
  end: number
}

function findOccurrencesInNormalized(normalized: string, normalizedTerm: string): NormOccurrence[] {
  if (!normalizedTerm || !normalized) {
    return []
  }
  const occurrences: NormOccurrence[] = []
  let from = 0
  for (;;) {
    const idx = normalized.indexOf(normalizedTerm, from)
    if (idx === -1) {
      break
    }
    occurrences.push({ start: idx, end: idx + normalizedTerm.length })
    from = idx + Math.max(1, normalizedTerm.length)
  }
  return occurrences
}

/**
 * Translates normalized-space occurrences back to original-space, building
 * the offset map only for fields that actually had occurrences — called
 * only for the hits that survive ranking + the caller's limit.
 */
function translateOccurrences(
  fields: Field[],
  occurrencesByField: NormOccurrence[][],
): Occurrence[][] {
  return fields.map((field, fieldOrdinal) => {
    const normOccurrences = occurrencesByField[fieldOrdinal]
    if (!normOccurrences || normOccurrences.length === 0) {
      return []
    }
    const { map } = normalizeWithMap(field.text)
    return normOccurrences.map(({ start, end }) => ({
      fieldIndex: fieldOrdinal,
      start: map[start],
      end: map[end - 1] + 1,
    }))
  })
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

interface Candidate {
  recording: Recording
  fields: Field[]
  score: number
  matchCount: number
  occurrencesByField: NormOccurrence[][]
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

  const candidates: Candidate[] = []
  for (const recording of recordings) {
    const fields = fieldsForRecording(recording, options.scope)
    if (fields.length === 0 || normalizedTerms.length === 0) {
      continue
    }

    // Normalize each field once per search, not once per term (the hot loop below is
    // normalizedTerms × fields; re-normalizing per term made this linear in term count).
    const normalizedFields = fields.map((field) => normalizeOnly(field.text))

    const occurrencesByField: NormOccurrence[][] = fields.map(() => [])
    const matchedTerms = new Set<string>()
    let weightedHits = 0
    let matchCount = 0

    normalizedTerms.forEach((normTerm) => {
      fields.forEach((field, fieldOrdinal) => {
        const occurrences = findOccurrencesInNormalized(normalizedFields[fieldOrdinal], normTerm)
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

    candidates.push({ recording, fields, score, matchCount, occurrencesByField })
  }

  candidates.sort((a, b) => b.score - a.score)

  // Offset maps + snippets are the expensive part (per-character map build). Only the
  // hits the caller will actually render need them — the rest report snippets: [].
  const snippetLimit = options.limit ?? candidates.length
  const hits: SearchHit[] = candidates.map((c, i) => ({
    recording: c.recording,
    score: c.score,
    matchCount: c.matchCount,
    snippets:
      i < snippetLimit
        ? buildSnippets(
            c.fields,
            translateOccurrences(c.fields, c.occurrencesByField),
            options.contextChars,
            maxSnippets,
          )
        : [],
  }))

  return { terms, hits }
}
