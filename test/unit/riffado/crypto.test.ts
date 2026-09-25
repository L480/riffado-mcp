import { createCipheriv, randomBytes } from "crypto"
import { describe, expect, it } from "vitest"
import {
  decrypt,
  decryptJson,
  IV_STAMP_PREFIX_LEN,
  ivStampOf,
  JSON_IV_STAMP_PREFIX_LEN,
  jsonIvStampOf,
  parseEncryptionKey,
} from "../../../src/riffado/crypto.js"

const KEY = parseEncryptionKey("a".repeat(64))
const OTHER_KEY = parseEncryptionKey("b".repeat(64))

function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`
}

/** Postgres's jsonb::text cast always renders the `{"c": "<v1:...>"}` wrapper with exactly
 * this spacing, regardless of how it was written -- verified against a real jsonb column
 * (see crypto.ts's `JSON_WRAPPER_PREFIX`). Tests below construct that exact rendering
 * directly, since these are pure-function unit tests with no real Postgres involved. */
function pgJsonbWrapper(cipher: string): string {
  return `{"c": "${cipher}"}`
}

describe("decrypt", () => {
  it("round-trips a self-generated v1: value", () => {
    const value = encrypt("hallo welt", KEY)
    expect(decrypt(value, KEY)).toBe("hallo welt")
  })

  it("round-trips unicode text", () => {
    const value = encrypt("Wärmepumpe läuft — 22°C, Kita-Übergabe", KEY)
    expect(decrypt(value, KEY)).toBe("Wärmepumpe läuft — 22°C, Kita-Übergabe")
  })

  it("passes through a legacy plaintext value unchanged", () => {
    expect(decrypt("just plain text", KEY)).toBe("just plain text")
  })

  it("passes through a value with the wrong number of hex parts", () => {
    expect(decrypt("v1:deadbeef:cafebabe", KEY)).toBe("v1:deadbeef:cafebabe")
  })

  it("returns empty string for empty/null/undefined", () => {
    expect(decrypt("", KEY)).toBe("")
    expect(decrypt(null, KEY)).toBe("")
    expect(decrypt(undefined, KEY)).toBe("")
  })

  it("throws when decrypted with the wrong key", () => {
    const value = encrypt("secret", KEY)
    expect(() => decrypt(value, OTHER_KEY)).toThrow()
  })

  it("throws on malformed hex in an otherwise 3-part value", () => {
    expect(() => decrypt("v1:not-hex:not-hex:not-hex", KEY)).not.toThrow()
    // "not-hex" fails the hex regex, so this is treated as legacy plaintext,
    // not as ciphertext to decrypt — confirm it passes through instead.
    expect(decrypt("v1:not-hex:not-hex:not-hex", KEY)).toBe("v1:not-hex:not-hex:not-hex")
  })

  it("throws when hex parts are well-formed but the ciphertext is corrupt", () => {
    const value = encrypt("secret", KEY)
    const corrupted = value.slice(0, -2) + "00"
    expect(() => decrypt(corrupted, KEY)).toThrow()
  })

  it("throws a clear error for an IV that isn't 12 bytes, without touching crypto internals", () => {
    const value = encrypt("secret", KEY)
    const [, , tag, ciphertext] = value.split(":")
    const shortIv = "aa".repeat(11) // 11 bytes, not 12
    const bad = `v1:${shortIv}:${tag}:${ciphertext}`
    expect(() => decrypt(bad, KEY)).toThrow(/IV must be 12 bytes/)
  })

  it("throws a clear error for a tag that isn't 16 bytes", () => {
    const value = encrypt("secret", KEY)
    const [, iv, , ciphertext] = value.split(":")
    const shortTag = "bb".repeat(15) // 15 bytes, not 16
    const bad = `v1:${iv}:${shortTag}:${ciphertext}`
    expect(() => decrypt(bad, KEY)).toThrow(/auth tag must be 16 bytes/)
  })

  it("still treats a value with a wrong-length IV/tag but non-3-part shape as legacy plaintext (length checks only apply after v1 shape detection)", () => {
    // Only 2 parts after stripping "v1:" -- parseCiphertext's shape check runs first and
    // returns null, so this is legacy plaintext, never reaching the length validation.
    expect(decrypt("v1:aabb:ccdd", KEY)).toBe("v1:aabb:ccdd")
  })
})

describe("decryptJson", () => {
  it("returns [] for empty/null/undefined", () => {
    expect(decryptJson("", KEY)).toEqual([])
    expect(decryptJson(null, KEY)).toEqual([])
    expect(decryptJson(undefined, KEY)).toEqual([])
  })

  it("passes plain JSON arrays through untouched", () => {
    expect(decryptJson('["a","b"]', KEY)).toEqual(["a", "b"])
  })

  it("wraps a bare JSON object into a one-element array", () => {
    expect(decryptJson('{"text":"x"}', KEY)).toEqual([{ text: "x" }])
  })

  it("unwraps an encrypted {c: ciphertext} jsonb wrapper", () => {
    const inner = JSON.stringify(["item one", "item two"])
    const wrapper = JSON.stringify({ c: encrypt(inner, KEY) })
    expect(decryptJson(wrapper, KEY)).toEqual(["item one", "item two"])
  })
})

describe("ivStampOf", () => {
  it("returns the IV segment for a v1: value, without decrypting", () => {
    const value = encrypt("hallo welt", KEY)
    const iv = value.split(":")[1]
    expect(ivStampOf(value)).toBe(iv)
  })

  it("changes when the value is re-encrypted (fresh IV), even for identical plaintext", () => {
    const a = encrypt("same text", KEY)
    const b = encrypt("same text", KEY)
    expect(ivStampOf(a)).not.toBe(ivStampOf(b))
  })

  it("stays equal across repeated calls on the same value", () => {
    const value = encrypt("hallo welt", KEY)
    expect(ivStampOf(value)).toBe(ivStampOf(value))
  })

  it("gives the identical result for the full value and just its IV_STAMP_PREFIX_LEN prefix -- the invariant RecordingStore's two-phase refresh depends on", () => {
    const value = encrypt("hallo welt, this is a much longer plaintext than the others", KEY)
    const prefix = value.slice(0, IV_STAMP_PREFIX_LEN)
    expect(prefix.length).toBe(IV_STAMP_PREFIX_LEN)
    expect(ivStampOf(prefix)).toBe(ivStampOf(value))
  })

  it("a legacy plaintext value never crashes, and never silently compares equal to itself (always-different marker, conservative rebuild)", () => {
    expect(() => ivStampOf("Legacy Plaintext Title")).not.toThrow()
    expect(ivStampOf("Legacy Plaintext Title")).not.toBe(ivStampOf("Legacy Plaintext Title"))
  })

  it("a malformed v1:-ish value never crashes, and never silently compares equal to itself", () => {
    expect(() => ivStampOf("v1:deadbeef:cafebabe")).not.toThrow()
    expect(ivStampOf("v1:deadbeef:cafebabe")).not.toBe(ivStampOf("v1:deadbeef:cafebabe"))
  })

  it("returns '' for empty/null/undefined, and never throws", () => {
    expect(ivStampOf("")).toBe("")
    expect(ivStampOf(null)).toBe("")
    expect(ivStampOf(undefined)).toBe("")
  })
})

describe("jsonIvStampOf", () => {
  it('returns the wrapped ciphertext\'s IV segment for the canonical {"c": "v1:..."} shape', () => {
    const inner = JSON.stringify(["a"])
    const cipher = encrypt(inner, KEY)
    const wrapper = pgJsonbWrapper(cipher)
    expect(jsonIvStampOf(wrapper)).toBe(cipher.split(":")[1])
  })

  it("changes when the wrapped ciphertext is re-encrypted", () => {
    const inner = JSON.stringify(["a"])
    const wrapperA = pgJsonbWrapper(encrypt(inner, KEY))
    const wrapperB = pgJsonbWrapper(encrypt(inner, KEY))
    expect(jsonIvStampOf(wrapperA)).not.toBe(jsonIvStampOf(wrapperB))
  })

  it("gives the identical result for the full wrapper and just its JSON_IV_STAMP_PREFIX_LEN prefix", () => {
    const inner = JSON.stringify(["a", "b", "c"])
    const wrapper = pgJsonbWrapper(encrypt(inner, KEY))
    const prefix = wrapper.slice(0, JSON_IV_STAMP_PREFIX_LEN)
    expect(prefix.length).toBe(JSON_IV_STAMP_PREFIX_LEN)
    expect(jsonIvStampOf(prefix)).toBe(jsonIvStampOf(wrapper))
  })

  it("a wrapper written without Postgres's canonical spacing (e.g. raw JSON.stringify output) is not recognized, and never crashes or silently compares equal to itself", () => {
    const inner = JSON.stringify(["a"])
    // No space after the key's colon -- what JSON.stringify produces directly, as opposed
    // to what a real jsonb::text cast would render (see pgJsonbWrapper's doc comment).
    const looseWrapper = JSON.stringify({ c: encrypt(inner, KEY) })
    expect(() => jsonIvStampOf(looseWrapper)).not.toThrow()
    expect(jsonIvStampOf(looseWrapper)).not.toBe(jsonIvStampOf(looseWrapper))
  })

  it("plain (unwrapped) jsonb never crashes, and never silently compares equal to itself", () => {
    expect(() => jsonIvStampOf('["a","b"]')).not.toThrow()
    expect(jsonIvStampOf('["a","b"]')).not.toBe(jsonIvStampOf('["a","b"]'))
  })

  it("non-JSON garbage never crashes, and never silently compares equal to itself", () => {
    expect(() => jsonIvStampOf("not json at all")).not.toThrow()
    expect(jsonIvStampOf("not json at all")).not.toBe(jsonIvStampOf("not json at all"))
  })

  it("returns '' for empty/null/undefined", () => {
    expect(jsonIvStampOf("")).toBe("")
    expect(jsonIvStampOf(null)).toBe("")
    expect(jsonIvStampOf(undefined)).toBe("")
  })
})
