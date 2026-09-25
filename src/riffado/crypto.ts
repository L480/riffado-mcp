/**
 * Riffado at-rest decryption, ported from `riffado_export.py` (same tolerances).
 *
 * Format: `v1:<iv>:<tag>:<ciphertext>`, all hex, AES-256-GCM, no AAD, key =
 * `ENCRYPTION_KEY` as 64 hex chars (32 bytes). Rows that don't match the
 * 3-hex-part shape (after stripping a leading `v1:`) are legacy plaintext
 * and pass through verbatim — never throw on those.
 */
import { createDecipheriv, randomUUID } from "crypto"

const HEX = /^[0-9a-fA-F]+$/
const IV_HEX_LEN = 24 // 12-byte IV, hex-encoded -- see store.ts's METADATA_QUERY comment.
/** Matches only the IV segment at the START of a `v1:iv:tag:ciphertext`
 * value -- deliberately not the trailing `:tag:ciphertext`, so this also
 * matches a SQL-truncated prefix that never had the rest to begin with. */
const V1_IV_PREFIX_RE = /^v1:([0-9a-fA-F]{24})/
/** How many leading characters of a `v1:iv:tag:ciphertext` value contain its
 * IV -- `"v1:".length + IV_HEX_LEN`. `RecordingStore`'s phase-1 stamp query
 * selects exactly this many characters (`left(column, IV_STAMP_PREFIX_LEN)`),
 * and `ivStampOf` never looks past this point, so feeding it either the full
 * column value or just that prefix gives the identical result. */
export const IV_STAMP_PREFIX_LEN = 3 + IV_HEX_LEN // 27

/**
 * Postgres's `jsonb::text` cast canonicalizes the `{"c": "<v1:...>"}`
 * wrapper to exactly this spacing -- one space after the key's colon --
 * regardless of how the value was originally written (verified against a
 * real jsonb column; jsonb never preserves the input's own whitespace).
 */
const JSON_WRAPPER_PREFIX = '{"c": "v1:'
const JSON_WRAPPER_V1_IV_PREFIX_RE = /^\{"c": "v1:([0-9a-fA-F]{24})/
/** Leading characters of a canonical `{"c": "v1:iv:tag:ciphertext"}` jsonb
 * wrapper that contain its IV -- see `IV_STAMP_PREFIX_LEN`. */
export const JSON_IV_STAMP_PREFIX_LEN = JSON_WRAPPER_PREFIX.length + IV_HEX_LEN // 34

interface CiphertextParts {
  iv: string
  tag: string
  ciphertext: string
}

/** Splits a `v1:iv:tag:ciphertext` value into its hex parts. `null` for
 * anything that isn't exactly 3 hex parts after stripping a leading `v1:`
 * segment (legacy unencrypted row, or malformed). */
function parseCiphertext(value: string): CiphertextParts | null {
  let parts = value.split(":")
  if (parts[0] === "v1") {
    parts = parts.slice(1)
  }
  if (parts.length !== 3 || !parts.every((p) => p.length > 0 && HEX.test(p))) {
    return null
  }
  const [iv, tag, ciphertext] = parts
  return { iv, tag, ciphertext }
}

/**
 * Decrypts a single `v1:iv:tag:ciphertext` value. Empty/undefined input
 * returns `""`. A value that isn't exactly 3 hex parts (after stripping a
 * leading `v1:` segment) is returned unchanged (legacy unencrypted row).
 */
export function decrypt(value: string | null | undefined, key: Buffer): string {
  if (!value) {
    return ""
  }
  const parsed = parseCiphertext(value)
  if (!parsed) {
    return value
  }

  // parseCiphertext only checks "3 hex parts" -- it has to stay that lax so
  // legacy plaintext detection (falling through to the `return value`
  // above) isn't disturbed. The standard AES-GCM sizes (12-byte IV,
  // 16-byte tag) are only enforced here, once a value has already been
  // recognized as v1 ciphertext, so a malformed/truncated value fails
  // loudly instead of silently passing a wrong-length IV/tag to Node's
  // crypto internals.
  // Checked on the hex strings, not the decoded buffers: Buffer.from(hex)
  // silently drops a trailing odd nibble, so a 25-char IV would decode to
  // 12 bytes and an odd-length ciphertext would lose its last half-byte.
  if (parsed.iv.length !== 24) {
    throw new Error(`invalid v1 ciphertext: IV must be 24 hex chars, got ${parsed.iv.length}`)
  }
  if (parsed.tag.length !== 32) {
    throw new Error(
      `invalid v1 ciphertext: auth tag must be 32 hex chars, got ${parsed.tag.length}`,
    )
  }
  if (parsed.ciphertext.length % 2 !== 0) {
    throw new Error("invalid v1 ciphertext: ciphertext has an odd number of hex chars")
  }
  const iv = Buffer.from(parsed.iv, "hex")
  const tag = Buffer.from(parsed.tag, "hex")
  const ciphertext = Buffer.from(parsed.ciphertext, "hex")

  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 })
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plain.toString("utf8")
}

/**
 * Cheap, decrypt-free per-field change signal for `RecordingStore`'s
 * incremental refresh: the IV segment at the start of a
 * `v1:iv:tag:ciphertext` value. Any re-encryption of a field draws a fresh
 * random IV, so a changed IV segment always means changed content. This
 * only ever inspects the value's first `IV_STAMP_PREFIX_LEN` characters --
 * deliberately, so the store's two-phase refresh can feed it either the
 * full column value (phase 2) or just a SQL-truncated
 * `left(column, IV_STAMP_PREFIX_LEN)` prefix (phase 1) and get the
 * identical result; the two phases must never disagree about a recording
 * that didn't change, or every recording would look changed forever.
 *
 * A value that doesn't start with the `v1:` + 24-hex-IV shape -- legacy
 * plaintext, malformed, or shorter than the prefix -- has no IV to key off
 * of. Unlike a full value, a bare prefix can't fall back to "compare the
 * rest of the value too" (there is no rest, in phase 1). Rather than guess,
 * this returns a fresh marker on every call that can never equal any other
 * call's marker, so a recording with a field in this shape is always
 * treated as changed and rebuilt -- conservative by construction, and the
 * only honest answer a prefix-only signal can give.
 */
export function ivStampOf(value: string | null | undefined): string {
  if (!value) {
    return ""
  }
  const m = V1_IV_PREFIX_RE.exec(value)
  return m ? m[1] : `unknown:${randomUUID()}`
}

/**
 * Same idea as `ivStampOf`, for the `{"c": "<v1:...>"}` encrypted jsonb
 * wrapper `decryptJson` also understands (`key_points`/`action_items`).
 * Only recognizes that exact, single-key, canonically-spaced shape
 * (`JSON_WRAPPER_PREFIX`) -- the one form a bare prefix can verify without
 * actually parsing JSON, which a truncated prefix isn't valid JSON to
 * begin with. Plain (unwrapped, never-encrypted) jsonb, a differently
 * shaped wrapper, or a prefix truncated before the IV all fall back to the
 * same always-different marker as `ivStampOf`, for the same reason.
 */
export function jsonIvStampOf(value: string | null | undefined): string {
  if (!value) {
    return ""
  }
  const m = JSON_WRAPPER_V1_IV_PREFIX_RE.exec(value)
  return m ? m[1] : `unknown:${randomUUID()}`
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
