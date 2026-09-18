import { describe, expect, it } from "vitest"
import {
  flattenListItem,
  formatDuration,
  sliceText,
  snippet,
  titleOrFallback,
} from "../../../src/riffado/format.js"

describe("formatDuration", () => {
  it("formats ms as H:MM:SS", () => {
    expect(formatDuration(0)).toBe("0:00:00")
    expect(formatDuration(61_000)).toBe("0:01:01")
    expect(formatDuration(3_661_000)).toBe("1:01:01")
    expect(formatDuration(3_600_000 * 25)).toBe("25:00:00")
  })

  it("rounds sub-second durations", () => {
    expect(formatDuration(999)).toBe("0:00:01")
  })
})

describe("flattenListItem", () => {
  it("joins truthy object values with an em dash", () => {
    expect(flattenListItem({ who: "Nico", what: "call plumber", when: "" })).toBe(
      "Nico — call plumber",
    )
  })

  it("stringifies non-object items", () => {
    expect(flattenListItem("just a string")).toBe("just a string")
  })

  it("drops false/null/undefined values but keeps falsy-but-present numbers", () => {
    expect(flattenListItem({ a: 0, b: "keep", c: null, d: false })).toBe("0 — keep")
  })
})

describe("titleOrFallback", () => {
  it("keeps a non-empty title", () => {
    expect(titleOrFallback("Meeting notes", "rec-1")).toBe("Meeting notes")
  })

  it("falls back to the id when the title is empty or whitespace", () => {
    expect(titleOrFallback("", "rec-1")).toBe("rec-1")
    expect(titleOrFallback("   ", "rec-1")).toBe("rec-1")
  })
})

describe("sliceText", () => {
  const text = "0123456789"

  it("returns the full text when it fits", () => {
    const slice = sliceText(text, 0, 100)
    expect(slice).toEqual({
      text: "0123456789",
      truncated: false,
      nextOffset: undefined,
      remainingChars: undefined,
    })
  })

  it("truncates and reports the next offset + remaining chars", () => {
    const slice = sliceText(text, 0, 4)
    expect(slice.text).toBe("0123")
    expect(slice.truncated).toBe(true)
    expect(slice.nextOffset).toBe(4)
    expect(slice.remainingChars).toBe(6)
  })

  it("continues from a given offset", () => {
    const slice = sliceText(text, 4, 4)
    expect(slice.text).toBe("4567")
    expect(slice.nextOffset).toBe(8)
    expect(slice.remainingChars).toBe(2)
  })

  it("clamps an out-of-range offset", () => {
    const slice = sliceText(text, 1000, 4)
    expect(slice.text).toBe("")
    expect(slice.truncated).toBe(false)
  })
})

describe("snippet", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(snippet("a".repeat(300), 10)).toBe("a".repeat(10) + "…")
  })

  it("leaves short text untouched", () => {
    expect(snippet("hello   world", 100)).toBe("hello world")
  })
})
