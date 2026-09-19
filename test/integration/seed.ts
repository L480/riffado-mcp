/** Seeds a throwaway Postgres with rows encrypted under a fixed test key,
 * using the same at-rest format the real Riffado app writes. */
import { createCipheriv, randomBytes } from "crypto"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type pg from "pg"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const TEST_ENCRYPTION_KEY = "11".repeat(32) // 64 hex chars

export function encryptForTest(plain: string, hexKey: string = TEST_ENCRYPTION_KEY): string {
  const key = Buffer.from(hexKey, "hex")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`
}

/** Encrypted-wrapper jsonb shape: `{"c": "<v1:...>"}` -- exported so other test files can
 * seed a fully-encrypted key_points/action_items row of their own. */
export function encJson(value: unknown): string {
  return JSON.stringify({ c: encryptForTest(JSON.stringify(value)) })
}

/** Creates the schema (idempotent) on a throwaway/test database. */
export async function migrate(client: pg.Pool | pg.Client): Promise<void> {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8")
  await client.query(sql)
}

/** Wipes and reseeds fixture rows. Must run against a client WITHOUT the
 * read-only transaction guard (setup only — never the app's own pool). */
export async function seed(client: pg.Pool | pg.Client): Promise<void> {
  await client.query("TRUNCATE ai_enhancements, transcriptions, recordings")

  // rec-active: two transcript sources on one recording, plain jsonb key_points,
  // encrypted-wrapper jsonb action_items — exercises both jsonb shapes.
  await client.query(
    `INSERT INTO recordings (id, user_id, filename, duration, start_time, is_trash, deleted_at)
     VALUES ($1, $2, $3, $4, $5, false, NULL)`,
    ["rec-active", "u1", encryptForTest("Kita Übergabe"), 754000, "2026-09-15 08:00:00"],
  )
  await client.query(
    `INSERT INTO transcriptions (id, recording_id, user_id, text, provider, model, detected_language, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      "t-active-riffado",
      "rec-active",
      "u1",
      encryptForTest("Wir sprechen heute über die Kita-Übergabe."),
      "openai",
      "whisper-1",
      "de",
      "riffado",
    ],
  )
  await client.query(
    `INSERT INTO transcriptions (id, recording_id, user_id, text, provider, model, detected_language, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      "t-active-manual",
      "rec-active",
      "u1",
      encryptForTest("Manuell nachgetragene Notizen."),
      "human",
      "n/a",
      "de",
      "manual",
    ],
  )
  await client.query(
    `INSERT INTO ai_enhancements (id, recording_id, user_id, summary, key_points, action_items, provider, model, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      "e-active",
      "rec-active",
      "u1",
      encryptForTest("Besprochen wurde die Kita-Übergabe."),
      JSON.stringify(["Neue Erzieherin ab Oktober"]), // plain jsonb, not wrapped
      encJson([{ who: "Nico", what: "Formular unterschreiben" }]), // encrypted-wrapper jsonb
      "openai",
      "gpt-4o-mini",
      "riffado",
    ],
  )

  // rec-trashed: must never surface (is_trash = true).
  await client.query(
    `INSERT INTO recordings (id, user_id, filename, duration, start_time, is_trash, deleted_at)
     VALUES ($1, $2, $3, $4, $5, true, NULL)`,
    ["rec-trashed", "u1", encryptForTest("Trashed recording"), 1000, "2026-09-10 08:00:00"],
  )

  // rec-deleted: must never surface (deleted_at set).
  await client.query(
    `INSERT INTO recordings (id, user_id, filename, duration, start_time, is_trash, deleted_at)
     VALUES ($1, $2, $3, $4, $5, false, $6)`,
    [
      "rec-deleted",
      "u1",
      encryptForTest("Deleted recording"),
      1000,
      "2026-09-11 08:00:00",
      "2026-09-12 00:00:00",
    ],
  )

  // rec-legacy: unencrypted plaintext filename (pre-encryption row).
  await client.query(
    `INSERT INTO recordings (id, user_id, filename, duration, start_time, is_trash, deleted_at)
     VALUES ($1, $2, $3, $4, $5, false, NULL)`,
    ["rec-legacy", "u1", "Legacy Plaintext Title", 500, "2026-01-01 08:00:00"],
  )
}
