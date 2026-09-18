import { describe, expect, it } from "vitest"
import { normalize, parseQueryTerms, searchRecordings } from "../../../src/riffado/search.js"
import type { Recording } from "../../../src/riffado/types.js"

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

describe("searchRecordings", () => {
  it("ranks a recording matching all terms above one matching a single term many times", () => {
    const recordings = [
      rec({
        id: "single-term-heavy",
        transcripts: [
          { source: "riffado", provider: "p", model: "m", text: "kita kita kita kita kita" },
        ],
      }),
      rec({
        id: "full-coverage",
        transcripts: [
          { source: "riffado", provider: "p", model: "m", text: "kita und heizung besprochen" },
        ],
      }),
    ]
    const { hits } = searchRecordings(recordings, "kita heizung", {
      scope: "all",
      contextChars: 50,
    })
    expect(hits[0].recording.id).toBe("full-coverage")
  })

  it("is case and diacritic insensitive", () => {
    const recordings = [rec({ title: "Wärmepumpe" })]
    const { hits } = searchRecordings(recordings, "warmepumpe", { scope: "all", contextChars: 50 })
    expect(hits).toHaveLength(1)
  })

  it("matches a quoted phrase literally", () => {
    const recordings = [
      rec({ id: "a", summary: "die kita übergabe war gut" }),
      rec({ id: "b", summary: "die übergabe an die kita war gut" }),
    ]
    const { hits } = searchRecordings(recordings, '"kita übergabe"', {
      scope: "all",
      contextChars: 50,
    })
    expect(hits.map((h) => h.recording.id)).toEqual(["a"])
  })

  it("respects scope: transcript excludes summary-only matches", () => {
    const recordings = [rec({ id: "a", summary: "only in summary: einzigartig" })]
    const { hits } = searchRecordings(recordings, "einzigartig", {
      scope: "transcript",
      contextChars: 50,
    })
    expect(hits).toHaveLength(0)
  })

  it("respects scope: summary excludes transcript-only matches", () => {
    const recordings = [
      rec({
        id: "a",
        transcripts: [{ source: "riffado", provider: "p", model: "m", text: "einzigartig" }],
      }),
    ]
    const { hits } = searchRecordings(recordings, "einzigartig", {
      scope: "summary",
      contextChars: 50,
    })
    expect(hits).toHaveLength(0)
  })

  it("produces snippet windows with ellipsis when truncated", () => {
    const longText = `${"x".repeat(200)} needle ${"y".repeat(200)}`
    const recordings = [
      rec({ transcripts: [{ source: "riffado", provider: "p", model: "m", text: longText }] }),
    ]
    const { hits } = searchRecordings(recordings, "needle", { scope: "all", contextChars: 20 })
    expect(hits[0].snippets[0]).toContain("needle")
    expect(hits[0].snippets[0].startsWith("…")).toBe(true)
    expect(hits[0].snippets[0].endsWith("…")).toBe(true)
  })

  it("caps snippets at 3 per recording by default", () => {
    const text = Array.from({ length: 10 }, (_, i) => `needle-${i} filler ${"z".repeat(80)}`).join(
      " ",
    )
    const recordings = [
      rec({ transcripts: [{ source: "riffado", provider: "p", model: "m", text }] }),
    ]
    const { hits } = searchRecordings(recordings, "filler", { scope: "all", contextChars: 10 })
    expect(hits[0].snippets.length).toBeLessThanOrEqual(3)
  })

  it("returns no hits and the searched terms when nothing matches", () => {
    const recordings = [rec({ title: "Nothing relevant" })]
    const { hits, terms } = searchRecordings(recordings, "xyzzy plugh", {
      scope: "all",
      contextChars: 50,
    })
    expect(hits).toEqual([])
    expect(terms).toEqual(["xyzzy", "plugh"])
  })
})
