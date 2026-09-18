/**
 * Riffado at-rest decryption, ported from `riffado_export.py` (same tolerances).
 *
 * Format: `v1:<iv>:<tag>:<ciphertext>`, all hex, AES-256-GCM, no AAD, key =
 * `ENCRYPTION_KEY` as 64 hex chars (32 bytes). Rows that don't match the
 * 3-hex-part shape (after stripping a leading `v1:`) are legacy plaintext
 * and pass through verbatim — never throw on those.
 */
import { createDecipheriv } from "crypto"

const HEX = /^[0-9a-fA-F]+$/

/**
 * Decrypts a single `v1:iv:tag:ciphertext` value. Empty/undefined input
 * returns `""`. A value that isn't exactly 3 hex parts (after stripping a
 * leading `v1:` segment) is returned unchanged (legacy unencrypted row).
 */
export function decrypt(value: string | null | undefined, key: Buffer): string {
  if (!value) {
    return ""
  }
  let parts = value.split(":")
  if (parts[0] === "v1") {
    parts = parts.slice(1)
  }
  if (parts.length !== 3 || !parts.every((p) => p.length > 0 && HEX.test(p))) {
    return value
  }
  const [ivHex, tagHex, ctHex] = parts
  const iv = Buffer.from(ivHex, "hex")
  const tag = Buffer.from(tagHex, "hex")
  const ciphertext = Buffer.from(ctHex, "hex")

  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plain.toString("utf8")
}

/**
 * Decrypts a `jsonb` column that is either plain JSON already, or a wrapper
 * `{"c": "<v1:...>"}` whose `c` field is the ciphertext of the real JSON.
 * Always returns an array (a bare object becomes a one-element array), or
 * `[]` for empty/NULL input.
 */
export function decryptJson(value: string | null | undefined, key: Buffer): unknown[] {
  if (!value) {
    return []
  }
  const data: unknown = JSON.parse(value)
  let resolved = data
  if (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    typeof (data as Record<string, unknown>).c === "string"
  ) {
    resolved = JSON.parse(decrypt((data as Record<string, unknown>).c as string, key))
  }
  return Array.isArray(resolved) ? resolved : [resolved]
}

/** Parses the 64-hex-char `ENCRYPTION_KEY` env value into raw key bytes. */
export function parseEncryptionKey(hexKey: string): Buffer {
  return Buffer.from(hexKey, "hex")
}
