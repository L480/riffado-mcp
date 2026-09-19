/**
 * Two-stage store: `get()` returns cheap metadata (+ transcript descriptors,
 * no text) for the whole corpus, refreshed and cached for `cacheTtlMs`.
 * `getTranscripts()` fetches + decrypts transcript text for specific
 * recording ids only, on demand, through a small LRU. Transcript text is
 * the expensive, not-always-needed part (search only needs it for the
 * stage-2 candidate set, `riffado_get_recording` only for one id at a
 * time) -- see `docs/architecture.md`.
 */
import type { Pool } from "pg"
import { decrypt, decryptJson } from "./crypto.js"
import { timestampToIsoUtc } from "./db.js"
import { flattenListItem, formatDuration, titleOrFallback } from "./format.js"
import { LruCache } from "./lru.js"
import { normalizedCheapFieldsFor, type NormalizedCheapFields } from "./search.js"
import type { Recording, TranscriptDescriptor, TranscriptText } from "./types.js"

export interface RecordingStoreOptions {
  pool: Pool
  encryptionKey: Buffer
  cacheTtlMs: number
  /** Restrict to one Riffado user; omit to include all users. */
  userId?: string
  /** Base URL for deep links, e.g. `https://riffado.example.com`. */
  appUrl?: string
  /** Max recordings' transcript text held in the on-demand LRU. */
  transcriptCacheSize?: number
}

interface MetaRow {
  id: string
  user_id: string
  filename: string | null
  duration: number | null
  start_time: string
  source: string | null
  provider: string | null
  model: string | null
  detected_language: string | null
  text_length: number | null
  summary: string | null
  key_points: string | null
  action_items: string | null
}

interface TranscriptRow {
  recording_id: string
  source: string
  text: string | null
}

// key_points/action_items are cast to text: see decryptJson()'s doc comment.
//
// text_length estimates the decrypted character count from the ciphertext's hex length
// (AES-256-GCM has no padding, so ciphertext byte length == plaintext UTF-8 byte length)
// without decrypting -- or even transferring -- the transcript text itself. `left(t.text, 3)`
// is a cheap prefix check (not a full-string scan like reverse()/regexp_replace() would be --
// tried that first, it made the metadata query slower than fetching the text used to be);
// 61 is strlen("v1:") + a 24-hex-char (12-byte) iv + ":" + a 32-hex-char (16-byte) tag + ":",
// the standard AES-GCM sizes every writer uses. A row in the rare legacy shape without the
// "v1:" prefix (still handled correctly by decrypt() itself, just not modeled here) or truly
// unencrypted falls through to the raw column length -- an overestimate for the former, exact
// for the latter. Approximate by design: this is a descriptor field, never used for slicing.
const METADATA_QUERY = `
SELECT r.id, r.user_id, r.filename, r.duration, r.start_time,
       t.source, t.provider, t.model, t.detected_language,
       CASE
         WHEN t.text IS NULL THEN NULL
         WHEN left(t.text, 3) = 'v1:' THEN GREATEST(length(t.text) - 61, 0) / 2
         ELSE length(t.text)
       END AS text_length,
       e.summary, e.key_points::text AS key_points, e.action_items::text AS action_items
FROM recordings r
LEFT JOIN transcriptions t ON t.recording_id = r.id
LEFT JOIN ai_enhancements e ON e.recording_id = r.id
WHERE r.deleted_at IS NULL AND NOT r.is_trash`

// Joins back to recordings (not just a bare `WHERE recording_id = ANY($1)`) so a stray or
// spoofed id can't pull another user's/a trashed/a deleted recording's transcript text.
const TRANSCRIPTS_QUERY = `
SELECT t.recording_id, t.source, t.text
FROM transcriptions t
JOIN recordings r ON r.id = t.recording_id
WHERE t.recording_id = ANY($1) AND r.deleted_at IS NULL AND NOT r.is_trash`

interface Snapshot {
  recordings: Recording[]
  normalizedFieldsById: Map<string, NormalizedCheapFields>
}

export class RecordingStore {
  private readonly pool: Pool
  private readonly encryptionKey: Buffer
  private readonly cacheTtlMs: number
  private readonly userId?: string
  private readonly appUrl?: string
  private readonly transcriptCache: LruCache<string, TranscriptText[]>

  private cache: Snapshot | null = null
  private cachedAt = 0
  private inFlight: Promise<Snapshot> | null = null

  constructor(options: RecordingStoreOptions) {
    this.pool = options.pool
    this.encryptionKey = options.encryptionKey
    this.cacheTtlMs = options.cacheTtlMs
    this.userId = options.userId
    this.appUrl = options.appUrl
    this.transcriptCache = new LruCache(options.transcriptCacheSize ?? 50)
  }

  /** Returns cached recording metadata (no transcript text), refreshing
   * when stale. Concurrent calls during a refresh share the same in-flight
   * query instead of firing duplicate loads. */
  async get(): Promise<Recording[]> {
    return (await this.snapshot()).recordings
  }

  /** Pre-normalized title/summary/key-points/action-items text per
   * recording id, built once per refresh -- stage-1 search never
   * re-normalizes these. Shares the same cache/TTL as `get()`. */
  async getNormalizedFields(): Promise<Map<string, NormalizedCheapFields>> {
    return (await this.snapshot()).normalizedFieldsById
  }

  private async snapshot(): Promise<Snapshot> {
    const now = Date.now()
    if (this.cache && now - this.cachedAt < this.cacheTtlMs) {
      return this.cache
    }
    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = null
      })
    }
    const snapshot = await this.inFlight
    this.cache = snapshot
    this.cachedAt = Date.now()
    return snapshot
  }

  /** Forces the next `get()`/`getNormalizedFields()` to reload, bypassing
   * the TTL, and drops the transcript LRU too (otherwise stale text could
   * outlive a metadata refresh). */
  invalidate(): void {
    this.cache = null
    this.cachedAt = 0
    this.transcriptCache.clear()
  }

  /** Cached recording count without forcing a refresh; used by `/health`. */
  getCachedCount(): number | undefined {
    return this.cache?.recordings.length
  }

  /**
   * Fetches + decrypts transcript text for exactly the given recording ids,
   * keyed by recording id then by source. Ids already in the LRU are served
   * from it; the rest are fetched in one query (`WHERE recording_id =
   * ANY($1)`, still parameterized, still on the read-only pool). Decrypted
   * text is cached in memory only -- never written to disk.
   */
  async getTranscripts(recordingIds: string[]): Promise<Map<string, TranscriptText[]>> {
    const uniqueIds = [...new Set(recordingIds)]
    const result = new Map<string, TranscriptText[]>()
    const misses: string[] = []

    for (const id of uniqueIds) {
      const cached = this.transcriptCache.get(id)
      if (cached) {
        result.set(id, cached)
      } else {
        misses.push(id)
      }
    }

    if (misses.length > 0) {
      const params: unknown[] = [misses]
      let query = TRANSCRIPTS_QUERY
      if (this.userId) {
        params.push(this.userId)
        query += ` AND r.user_id = $${params.length}`
      }
      const rows = await this.pool.query<TranscriptRow>(query, params)

      const byId = new Map<string, TranscriptText[]>()
      for (const row of rows.rows) {
        const texts = byId.get(row.recording_id) ?? []
        texts.push({ source: row.source, text: decrypt(row.text, this.encryptionKey) })
        byId.set(row.recording_id, texts)
      }
      for (const id of misses) {
        const texts = byId.get(id) ?? []
        this.transcriptCache.set(id, texts)
        result.set(id, texts)
      }
    }

    return result
  }

  private async refresh(): Promise<Snapshot> {
    const start = Date.now()
    const params: string[] = []
    let query = METADATA_QUERY
    if (this.userId) {
      params.push(this.userId)
      query += ` AND r.user_id = $${params.length}`
    }
    query += " ORDER BY r.start_time DESC"

    const result = await this.pool.query<MetaRow>(query, params)
    const recordings = this.buildRecordings(result.rows)
    const normalizedFieldsById = new Map<string, NormalizedCheapFields>()
    for (const rec of recordings) {
      normalizedFieldsById.set(rec.id, normalizedCheapFieldsFor(rec))
    }
    console.error(
      `[riffado-mcp] store refreshed: ${recordings.length} recording(s) from ${result.rows.length} row(s) in ${Date.now() - start}ms`,
    )
    return { recordings, normalizedFieldsById }
  }

  private buildRecordings(rows: MetaRow[]): Recording[] {
    const byId = new Map<string, Recording>()
    const order: string[] = []

    for (const row of rows) {
      let rec = byId.get(row.id)
      if (!rec) {
        const durationMs = row.duration ?? 0
        const summary = row.summary ? decrypt(row.summary, this.encryptionKey) : ""
        rec = {
          id: row.id,
          userId: row.user_id,
          title: titleOrFallback(decrypt(row.filename, this.encryptionKey), row.id),
          startedAt: timestampToIsoUtc(row.start_time),
          durationMs,
          duration: formatDuration(durationMs),
          summary: summary || undefined,
          keyPoints: decryptJson(row.key_points, this.encryptionKey).map(flattenListItem),
          actionItems: decryptJson(row.action_items, this.encryptionKey).map(flattenListItem),
          transcripts: [],
          url: this.appUrl ? `${this.appUrl.replace(/\/+$/, "")}/recordings/${row.id}` : undefined,
        }
        byId.set(row.id, rec)
        order.push(row.id)
      }

      if (row.source) {
        const descriptor: TranscriptDescriptor = {
          source: row.source,
          provider: row.provider ?? "",
          model: row.model ?? "",
          language: row.detected_language ?? undefined,
          textLength: row.text_length ?? 0,
        }
        rec.transcripts.push(descriptor)
      }
    }

    return order.map((id) => byId.get(id)!)
  }
}
