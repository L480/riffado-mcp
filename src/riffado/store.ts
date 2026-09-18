/**
 * Loads all (non-trashed, non-deleted) recordings + transcripts + AI
 * enhancements in one query, decrypts them, and caches the result for
 * `cacheTtlMs`. The dataset is tiny (a handful of recordings), so this is a
 * "load everything, decrypt, search in memory" store rather than a query
 * layer — see `docs/architecture.md` for why.
 */
import type { Pool } from "pg"
import { decrypt, decryptJson } from "./crypto.js"
import { timestampToIsoUtc } from "./db.js"
import { flattenListItem, formatDuration, titleOrFallback } from "./format.js"
import type { Recording, Transcript } from "./types.js"

export interface RecordingStoreOptions {
  pool: Pool
  encryptionKey: Buffer
  cacheTtlMs: number
  /** Restrict to one Riffado user; omit to include all users. */
  userId?: string
  /** Base URL for deep links, e.g. `https://riffado.example.com`. */
  appUrl?: string
}

interface Row {
  id: string
  user_id: string
  filename: string | null
  duration: number | null
  start_time: string
  source: string | null
  provider: string | null
  model: string | null
  detected_language: string | null
  text: string | null
  summary: string | null
  key_points: string | null
  action_items: string | null
}

const BASE_QUERY = `
SELECT r.id, r.user_id, r.filename, r.duration, r.start_time,
       t.source, t.provider, t.model, t.detected_language, t.text,
       e.summary, e.key_points, e.action_items
FROM recordings r
LEFT JOIN transcriptions t ON t.recording_id = r.id
LEFT JOIN ai_enhancements e ON e.recording_id = r.id
WHERE r.deleted_at IS NULL AND NOT r.is_trash`

export class RecordingStore {
  private readonly pool: Pool
  private readonly encryptionKey: Buffer
  private readonly cacheTtlMs: number
  private readonly userId?: string
  private readonly appUrl?: string

  private cache: Recording[] | null = null
  private cachedAt = 0
  private inFlight: Promise<Recording[]> | null = null

  constructor(options: RecordingStoreOptions) {
    this.pool = options.pool
    this.encryptionKey = options.encryptionKey
    this.cacheTtlMs = options.cacheTtlMs
    this.userId = options.userId
    this.appUrl = options.appUrl
  }

  /** Returns the cached recordings, refreshing when stale. Concurrent calls
   * during a refresh share the same in-flight query instead of firing
   * duplicate loads. */
  async get(): Promise<Recording[]> {
    const now = Date.now()
    if (this.cache && now - this.cachedAt < this.cacheTtlMs) {
      return this.cache
    }
    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = null
      })
    }
    const recordings = await this.inFlight
    this.cache = recordings
    this.cachedAt = Date.now()
    return recordings
  }

  /** Forces the next `get()` to reload, bypassing the TTL. */
  invalidate(): void {
    this.cache = null
    this.cachedAt = 0
  }

  /** Cached recording count without forcing a refresh; used by `/health`. */
  getCachedCount(): number | undefined {
    return this.cache?.length
  }

  private async refresh(): Promise<Recording[]> {
    const start = Date.now()
    const params: string[] = []
    let query = BASE_QUERY
    if (this.userId) {
      params.push(this.userId)
      query += ` AND r.user_id = $${params.length}`
    }
    query += " ORDER BY r.start_time DESC"

    const result = await this.pool.query<Row>(query, params)
    const recordings = this.buildRecordings(result.rows)
    console.error(
      `[riffado-mcp] store refreshed: ${recordings.length} recording(s) from ${result.rows.length} row(s) in ${Date.now() - start}ms`,
    )
    return recordings
  }

  private buildRecordings(rows: Row[]): Recording[] {
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
        const transcript: Transcript = {
          source: row.source,
          provider: row.provider ?? "",
          model: row.model ?? "",
          language: row.detected_language ?? undefined,
          text: decrypt(row.text, this.encryptionKey),
        }
        rec.transcripts.push(transcript)
      }
    }

    return order.map((id) => byId.get(id)!)
  }
}
