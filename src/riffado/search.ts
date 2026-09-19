/**
 * Two-stage in-memory search over decrypted metadata + on-demand transcript
 * text. Pure functions, no I/O of their own -- callers (`riffado-tools.ts`)
 * fetch data (`store.get()`, `store.getTranscripts()`) and pass results in.
 * See `docs/architecture.md` for why the DB can't do this and why an
 * inverted index was rejected.
 *
 * Stage 1 (`rankByCheapFields`) scores the whole corpus over pre-normalized
 * title/summary/key-points/action-items text only -- cheap, always in
 * memory (existing weights: title 5, summary/keyPoints/actionItems 4).
 * Stage 2 (`finalizeSearch`) adds transcript matches (weight 1) for a
 * caller-chosen candidate set (normally the stage-1 top-K, or every
 * recording under `deep: true`), merges the scores, and builds snippets.
 *
 * No stemming: callers (tool descriptions, the `riffado_ask` prompt) are
 * told to pass German *and* English term variants themselves.
 */
import type { Recording, TranscriptText } from "./types.js"

export type SearchScope = "all" | "transcript" | "summary"

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
 * map -- used during scanning, where only the normalized string is needed.
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
  /** Precomputed by `normalizedCheapFieldsFor`; when absent (transcript
   * fields), computed on the fly during scoring. */
  normalized?: string
}

/** Pre-normalized title/summary/key-points/action-items text for one
 * recording -- built once per store refresh, not once per search. */
export interface NormalizedCheapFields {
  title: string
  summary: string
  keyPoints: string
  actionItems: string
}

/** Builds the stage-1 normalized-field cache entry for one recording. */
export function normalizedCheapFieldsFor(recording: Recording): NormalizedCheapFields {
  return {
    title: normalize(recording.title),
    summary: recording.summary ? normalize(recording.summary) : "",
    keyPoints: recording.keyPoints.length > 0 ? normalize(recording.keyPoints.join(" \n ")) : "",
    actionItems:
      recording.actionItems.length > 0 ? normalize(recording.actionItems.join(" \n ")) : "",
  }
}

function cheapFields(recording: Recording, normalized: NormalizedCheapFields): Field[] {
  const fields: Field[] = [{ weight: 5, text: recording.title, normalized: normalized.title }]
  if (recording.summary) {
    fields.push({ weight: 4, text: recording.summary, normalized: normalized.summary })
  }
  if (recording.keyPoints.length > 0) {
    fields.push({
      weight: 4,
      text: recording.keyPoints.join(" \n "),
      normalized: normalized.keyPoints,
    })
  }
  if (recording.actionItems.length > 0) {
    fields.push({
      weight: 4,
      text: recording.actionItems.join(" \n "),
      normalized: normalized.actionItems,
    })
  }
  return fields
}

function transcriptFields(texts: TranscriptText[]): Field[] {
  return texts.map((t) => ({ weight: 1, text: t.text }))
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
 * the offset map only for fields that actually had occurrences -- called
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

interface FieldScore {
  occurrencesByField: NormOccurrence[][]
  matchedTerms: Set<string>
  weightedHits: number
  matchCount: number
}

/** Normalizes each field once per call (not once per term) and scans every
 * term against every field. */
function scoreFields(fields: Field[], normalizedTerms: string[]): FieldScore {
  const normalizedFieldTexts = fields.map((field) => field.normalized ?? normalizeOnly(field.text))
  const occurrencesByField: NormOccurrence[][] = fields.map(() => [])
  const matchedTerms = new Set<string>()
  let weightedHits = 0
  let matchCount = 0

  normalizedTerms.forEach((normTerm) => {
    fields.forEach((field, fieldOrdinal) => {
      const occurrences = findOccurrencesInNormalized(normalizedFieldTexts[fieldOrdinal], normTerm)
      if (occurrences.length > 0) {
        matchedTerms.add(normTerm)
        matchCount += occurrences.length
        weightedHits += occurrences.length * field.weight
        occurrencesByField[fieldOrdinal].push(...occurrences)
      }
    })
  })

  return { occurrencesByField, matchedTerms, weightedHits, matchCount }
}

function scoreOf(matchedTerms: Set<string>, weightedHits: number, termCount: number): number {
  const coverage = termCount > 0 ? matchedTerms.size / termCount : 0
  return coverage * 1000 + weightedHits
}

export interface RankedCandidate {
  recording: Recording
  fields: Field[]
  occurrencesByField: NormOccurrence[][]
  matchedTerms: Set<string>
  weightedHits: number
  matchCount: number
  cheapScore: number
}

/**
 * Stage 1: scores every recording's pre-normalized title/summary/key-points/
 * action-items, ranked descending by score. Includes zero-score recordings
 * too (`Array.sort` is stable, so ties keep the caller's original order) --
 * a caller slicing the top K still gets K entries even when few or no
 * recordings matched a cheap field. That matters for `finalizeSearch`: it's
 * what makes "candidate" vs "non-candidate" a meaningful, testable split
 * even for a term that appears in no title/summary at all.
 */
export function rankByCheapFields(
  recordings: Recording[],
  normalizedFieldsById: Map<string, NormalizedCheapFields>,
  normalizedTerms: string[],
): RankedCandidate[] {
  const ranked = recordings.map((recording) => {
    const normalized = normalizedFieldsById.get(recording.id) ?? normalizedCheapFieldsFor(recording)
    const fields = cheapFields(recording, normalized)
    const { occurrencesByField, matchedTerms, weightedHits, matchCount } = scoreFields(
      fields,
      normalizedTerms,
    )
    return {
      recording,
      fields,
      occurrencesByField,
      matchedTerms,
      weightedHits,
      matchCount,
      cheapScore: scoreOf(matchedTerms, weightedHits, normalizedTerms.length),
    }
  })
  ranked.sort((a, b) => b.cheapScore - a.cheapScore)
  return ranked
}

/** `K = min(max(limit * 3, 30), 200)` -- the stage-2 candidate-set size. An
 * internal tuning knob, not a tool parameter. */
export function computeCandidateK(limit: number): number {
  return Math.min(Math.max(limit * 3, 30), 200)
}

export interface FinalizeOptions {
  contextChars: number
  maxSnippetsPerRecording?: number
  /** Only the top `limit` ranked hits get snippets built (perf hint, doesn't
   * change results) -- the rest come back with `snippets: []`. */
  limit?: number
}

/**
 * Stage 2 + merge. `candidateIds` decides which ranked recordings get their
 * transcripts scored (normally the stage-1 top-K, or every recording under
 * `deep: true`); `transcriptsById` must already hold text for exactly those
 * ids (fetched by the caller via `store.getTranscripts`) -- an id outside
 * `candidateIds` is treated as having no transcript, even if
 * `transcriptsById` happens to hold an entry for it.
 *
 * `scope: "summary"` never looks at `candidateIds`/`transcriptsById` --
 * cheap-field matches only. `"transcript"` reports transcript-only matches
 * for the candidate set (cheap-field matches don't count, matching the old
 * single-stage `scope: "transcript"` behavior). `"all"` merges both.
 */
export function finalizeSearch(
  ranked: RankedCandidate[],
  terms: string[],
  normalizedTerms: string[],
  scope: SearchScope,
  candidateIds: Set<string>,
  transcriptsById: Map<string, TranscriptText[]>,
  options: FinalizeOptions,
): SearchResult {
  const maxSnippets = options.maxSnippetsPerRecording ?? 3

  interface Final {
    recording: Recording
    fields: Field[]
    occurrencesByField: NormOccurrence[][]
    matchedTerms: Set<string>
    weightedHits: number
    matchCount: number
  }

  const finals: Final[] = []

  for (const rc of ranked) {
    if (scope === "summary") {
      if (rc.matchedTerms.size > 0) {
        finals.push(rc)
      }
      continue
    }

    const isCandidate = candidateIds.has(rc.recording.id)
    const texts = isCandidate ? (transcriptsById.get(rc.recording.id) ?? []) : []
    const tFields = transcriptFields(texts)
    const tScore = scoreFields(tFields, normalizedTerms)

    if (scope === "transcript") {
      if (tScore.matchedTerms.size > 0) {
        finals.push({
          recording: rc.recording,
          fields: tFields,
          occurrencesByField: tScore.occurrencesByField,
          matchedTerms: tScore.matchedTerms,
          weightedHits: tScore.weightedHits,
          matchCount: tScore.matchCount,
        })
      }
      continue
    }

    // scope === "all": merge stage 1 (cheap) + stage 2 (transcript).
    const matchedTerms = new Set([...rc.matchedTerms, ...tScore.matchedTerms])
    if (matchedTerms.size > 0) {
      finals.push({
        recording: rc.recording,
        fields: [...rc.fields, ...tFields],
        occurrencesByField: [...rc.occurrencesByField, ...tScore.occurrencesByField],
        matchedTerms,
        weightedHits: rc.weightedHits + tScore.weightedHits,
        matchCount: rc.matchCount + tScore.matchCount,
      })
    }
  }

  const scored = finals.map((f) => ({
    ...f,
    score: scoreOf(f.matchedTerms, f.weightedHits, normalizedTerms.length),
  }))
  scored.sort((a, b) => b.score - a.score)

  // Offset maps + snippets are the expensive part (per-character map build). Only the
  // hits the caller will actually render need them -- the rest report snippets: [].
  const snippetLimit = options.limit ?? scored.length
  const hits: SearchHit[] = scored.map((c, i) => ({
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
