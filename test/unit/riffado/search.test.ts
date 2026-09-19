import { describe, expect, it, vi } from "vitest"
import {
  computeCandidateK,
  finalizeSearch,
  normalize,
  normalizedCheapFieldsFor,
  parseQueryTerms,
  rankByCheapFields,
} from "../../../src/riffado/search.js"
import type { NormalizedCheapFields } from "../../../src/riffado/search.js"
import type { Recording, TranscriptText } from "../../../src/riffado/types.js"

function rec(overrides: Partial<Recording>): Recording {
  return {
    id: "id",
    userId: "u1",
    title: "Untitled",
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 60000,
    duration: "0:01:00",
    keyPoints: [],
    actionItems: [],
    transcripts: [],
    ...overrides,
  }
}

function normalizedFieldsFor(recordings: Recording[]): Map<string, NormalizedCheapFields> {
  return new Map(recordings.map((r) => [r.id, normalizedCheapFieldsFor(r)]))
}

function rank(recordings: Recording[], query: string) {
  const terms = parseQueryTerms(query)
  const normalizedTerms = terms.map((t) => normalize(t))
  const ranked = rankByCheapFields(recordings, normalizedFieldsFor(recordings), normalizedTerms)
  return { ranked, terms, normalizedTerms }
}

describe("normalize", () => {
  it("lowercases and strips diacritics", () => {
    expect(normalize("Kita-Übergabe")).toBe("kita-ubergabe")
    expect(normalize("café RÉSUMÉ")).toBe("cafe resume")
  })
})

describe("parseQueryTerms", () => {
  it("splits on whitespace", () => {
    expect(parseQueryTerms("kita heizung")).toEqual(["kita", "heizung"])
  })

  it("keeps a quoted phrase as one term", () => {
    expect(parseQueryTerms('"Wärmepumpe läuft" kita')).toEqual(["Wärmepumpe läuft", "kita"])
  })
})

describe("rankByCheapFields (stage 1)", () => {
  it("ranks a recording matching all terms above one matching a single term many times", () => {
    const recordings = [
      rec({ id: "single-term-heavy", title: "kita kita kita kita kita" }),
      rec({ id: "full-coverage", title: "kita und heizung besprochen" }),
    ]
    const { ranked } = rank(recordings, "kita heizung")
    expect(ranked[0].recording.id).toBe("full-coverage")
  })

  it("is case and diacritic insensitive", () => {
    const recordings = [rec({ title: "Wärmepumpe" })]
    const { ranked } = rank(recordings, "warmepumpe")
    expect(ranked[0].matchedTerms.size).toBe(1)
  })

  it("matches a quoted phrase literally", () => {
    const recordings = [
      rec({ id: "a", summary: "die kita übergabe war gut" }),
      rec({ id: "b", summary: "die übergabe an die kita war gut" }),
    ]
    const { ranked } = rank(recordings, '"kita übergabe"')
    expect(ranked.filter((r) => r.matchedTerms.size > 0).map((r) => r.recording.id)).toEqual(["a"])
  })

  it("includes zero-score recordings too, in original order (stable sort)", () => {
    const recordings = [rec({ id: "a" }), rec({ id: "b" }), rec({ id: "c" })]
    const { ranked } = rank(recordings, "nomatch")
    expect(ranked.map((r) => r.recording.id)).toEqual(["a", "b", "c"])
    expect(ranked.every((r) => r.cheapScore === 0)).toBe(true)
  })
})

describe("computeCandidateK", () => {
  it("is at least 30, and grows with limit up to a cap of 200", () => {
    expect(computeCandidateK(1)).toBe(30)
    expect(computeCandidateK(10)).toBe(30)
    expect(computeCandidateK(50)).toBe(150)
    expect(computeCandidateK(100)).toBe(200)
    expect(computeCandidateK(500)).toBe(200)
  })
})

describe("finalizeSearch (stage 2 + merge)", () => {
  it("scope: summary never looks at transcriptsById, even with matching candidates", () => {
    const recordings = [rec({ id: "a", summary: "only in summary: einzigartig" })]
    const { ranked, terms, normalizedTerms } = rank(recordings, "einzigartig")
    // A non-empty transcriptsById proves scope: summary ignores it entirely.
    const transcriptsById = new Map<string, TranscriptText[]>([
      ["a", [{ source: "riffado", text: "einzigartig" }]],
    ])
    const { hits } = finalizeSearch(
      ranked,
      terms,
      normalizedTerms,
      "summary",
      new Set(["a"]),
      transcriptsById,
      { contextChars: 50 },
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].snippets[0]).toContain("summary")
  })

  it("scope: transcript excludes summary-only matches", () => {
    const recordings = [rec({ id: "a", summary: "only in summary: einzigartig" })]
    const { ranked, terms, normalizedTerms } = rank(recordings, "einzigartig")
    const { hits } = finalizeSearch(
      ranked,
      terms,
      normalizedTerms,
      "transcript",
      new Set(["a"]),
      new Map(),
      { contextChars: 50 },
    )
    expect(hits).toHaveLength(0)
  })

  it("two-stage: finds a term that is only in a candidate's transcript", () => {
    // "kita" matches the title (stage-1 candidate); "heizung" only appears in the transcript.
    const recordings = [rec({ id: "a", title: "Kita Übergabe" })]
    const { ranked, terms, normalizedTerms } = rank(recordings, "kita heizung")
    const transcriptsById = new Map<string, TranscriptText[]>([
      ["a", [{ source: "riffado", text: "wir besprechen die heizung" }]],
    ])
    const { hits } = finalizeSearch(
      ranked,
      terms,
      normalizedTerms,
      "all",
      new Set(["a"]),
      transcriptsById,
      { contextChars: 50 },
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].matchCount).toBe(2)
    expect(hits[0].snippets.some((s) => s.includes("heizung"))).toBe(true)
  })

  it(
    "deep: true widens the candidate set -- a non-candidate's transcript-only term is found " +
      "only once it's included in candidateIds/transcriptsById",
    () => {
      const recordings = [rec({ id: "candidate" }), rec({ id: "non-candidate" })]
      const { ranked, terms, normalizedTerms } = rank(recordings, "zzzneedle")
      const transcriptsById = new Map<string, TranscriptText[]>([
        ["candidate", [{ source: "riffado", text: "contains zzzneedle here" }]],
        ["non-candidate", [{ source: "riffado", text: "also contains zzzneedle here" }]],
      ])

      // deep: false -- only "candidate" is in the candidate set, even though
      // transcriptsById happens to have text for both (mirrors the tool only ever
      // fetching transcripts for the ids it decided to fetch).
      const shallow = finalizeSearch(
        ranked,
        terms,
        normalizedTerms,
        "all",
        new Set(["candidate"]),
        transcriptsById,
        { contextChars: 50 },
      )
      expect(shallow.hits.map((h) => h.recording.id)).toEqual(["candidate"])

      // deep: true -- every recording is a candidate.
      const deep = finalizeSearch(
        ranked,
        terms,
        normalizedTerms,
        "all",
        new Set(["candidate", "non-candidate"]),
        transcriptsById,
        { contextChars: 50 },
      )
      expect(deep.hits.map((h) => h.recording.id).sort()).toEqual(["candidate", "non-candidate"])
    },
  )

  it("produces snippet windows with ellipsis when truncated", () => {
    const longText = `${"x".repeat(200)} needle ${"y".repeat(200)}`
    const recordings = [rec({ id: "a" })]
    const { ranked, terms, normalizedTerms } = rank(recordings, "needle")
    const transcriptsById = new Map<string, TranscriptText[]>([
      ["a", [{ source: "riffado", text: longText }]],
    ])
    const { hits } = finalizeSearch(
      ranked,
      terms,
      normalizedTerms,
      "all",
      new Set(["a"]),
      transcriptsById,
      { contextChars: 20 },
    )
    expect(hits[0].snippets[0]).toContain("needle")
    expect(hits[0].snippets[0].startsWith("…")).toBe(true)
    expect(hits[0].snippets[0].endsWith("…")).toBe(true)
  })

  it("caps snippets at 3 per recording by default", () => {
    const text = Array.from({ length: 10 }, (_, i) => `needle-${i} filler ${"z".repeat(80)}`).join(
      " ",
    )
    const recordings = [rec({ id: "a" })]
    const { ranked, terms, normalizedTerms } = rank(recordings, "filler")
    const transcriptsById = new Map<string, TranscriptText[]>([
      ["a", [{ source: "riffado", text }]],
    ])
    const { hits } = finalizeSearch(
      ranked,
      terms,
      normalizedTerms,
      "all",
      new Set(["a"]),
      transcriptsById,
      { contextChars: 10 },
    )
    expect(hits[0].snippets.length).toBeLessThanOrEqual(3)
  })

  it("returns no hits and the searched terms when nothing matches", () => {
    const recordings = [rec({ id: "a", title: "Nothing relevant" })]
    const { ranked, terms, normalizedTerms } = rank(recordings, "xyzzy plugh")
    const { hits } = finalizeSearch(
      ranked,
      terms,
      normalizedTerms,
      "summary",
      new Set(),
      new Map(),
      {
        contextChars: 50,
      },
    )
    expect(hits).toEqual([])
    expect(terms).toEqual(["xyzzy", "plugh"])
  })

  it("normalizes each transcript field once per call, not once per term (perf regression pin)", () => {
    const filler = "the quick brown fox jumps over the lazy dog ".repeat(150)
    const recordings = [rec({ id: "a" })]
    const transcriptsById = new Map<string, TranscriptText[]>([
      ["a", [{ source: "riffado", text: filler }]],
    ])

    const spy = vi.spyOn(String.prototype, "normalize")

    const run = (query: string) => {
      const { ranked, terms, normalizedTerms } = rank(recordings, query)
      finalizeSearch(ranked, terms, normalizedTerms, "all", new Set(["a"]), transcriptsById, {
        contextChars: 50,
      })
    }

    spy.mockClear()
    run("zzznomatch1")
    const callsForOneTerm = spy.mock.calls.length

    spy.mockClear()
    run("zzznomatch1 zzznomatch2 zzznomatch3 zzznomatch4 zzznomatch5")
    const callsForFiveTerms = spy.mock.calls.length

    spy.mockRestore()

    expect(callsForOneTerm).toBeGreaterThan(0)
    expect(callsForFiveTerms).toBeLessThan(callsForOneTerm * 2)
  })
})
