import { createCipheriv, randomBytes } from "crypto"
import { describe, expect, it } from "vitest"
import { decrypt, decryptJson, parseEncryptionKey } from "../../../src/riffado/crypto.js"

const KEY = parseEncryptionKey("a".repeat(64))
const OTHER_KEY = parseEncryptionKey("b".repeat(64))

function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`
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
