/**
 * Two-stage store: `get()` returns cheap metadata (+ transcript descriptors,
 * no text) for the whole corpus, refreshed and cached for `cacheTtlMs`.
 * `getTranscripts()` fetches + decrypts transcript text for specific
 * recording ids only, on demand, through a small LRU. Transcript text is
 * the expensive, not-always-needed part (search only needs it for the
 * stage-2 candidate set, `riffado_get_recording` only for one id at a
 * time) -- see `docs/architecture.md`.
 *
 * `refresh()` (the metadata reload behind `get()`/`getNormalizedFields()`)
 * is itself two-phase -- not to be confused with the two-stage store/search
 * split above. Phase 1 (`STAMP_QUERY`) is a cheap query for a per-recording
 * change stamp only (IV prefixes, flags, ids -- never the full ciphertext).
 * Phase 2 (`METADATA_QUERY`) fetches full metadata, `WHERE r.id = ANY($1)`,
 * for only the ids phase 1 found new or changed; everything else is reused
 * by reference from the previous refresh, no decrypt/normalize/re-transfer.
 * See `docs/architecture.md`.
 */
import type { Pool } from "pg"
import {
  decrypt,
  decryptJson,
  IV_STAMP_PREFIX_LEN,
  ivStampOf,
  JSON_IV_STAMP_PREFIX_LEN,
  jsonIvStampOf,
} from "./crypto.js"
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

/**
 * A log-safe description of a decrypt/parse failure. Raw `err.message` is
 * not safe: `JSON.parse` quotes a snippet of its input, which here is
 * decrypted recording content. Only messages known to be content-free
 * (our own ciphertext-shape errors, Node's GCM authentication failure) are
 * passed through; anything else is reduced to its error class.
 */
export function safeErrorLabel(err: unknown): string {
  if (err instanceof SyntaxError) {
    return "invalid JSON (SyntaxError)"
  }
  if (
    err instanceof Error &&
    /^(invalid v1 ciphertext: |Unsupported state or unable to authenticate data$)/.test(err.message)
  ) {
    return err.message
  }
  return err instanceof Error ? err.name : "unknown error"
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

/** Phase-1 row: just enough to compute `stampFor()` -- prefixes, never the
 * full ciphertext. See `STAMP_QUERY`. */
interface StampRow {
  id: string
  is_trash: boolean
  deleted_at: string | null
  updated_at: string
  transcript_id: string | null
  source: string | null
  filename_prefix: string | null
  summary_prefix: string | null
  key_points_prefix: string | null
  action_items_prefix: string | null
}

// Phase 1 of refresh(): a cheap per-recording change stamp, without transferring any full
// ciphertext. `left(..., N)` selects only as many leading characters as ivStampOf()/
// jsonIvStampOf() ever look at (IV_STAMP_PREFIX_LEN/JSON_IV_STAMP_PREFIX_LEN, imported from
// crypto.ts, which also documents why a prefix this long gives those functions the exact
// same answer as the full value would) -- so this query moves roughly 200 bytes/recording
// instead of the ~8KB/recording phase 2 (METADATA_QUERY, below) would. See stampFor() and
// docs/architecture.md.
const STAMP_QUERY = `
SELECT r.id, r.is_trash, r.deleted_at, r.updated_at, t.id AS transcript_id, t.source,
       left(r.filename, ${IV_STAMP_PREFIX_LEN}) AS filename_prefix,
       left(e.summary, ${IV_STAMP_PREFIX_LEN}) AS summary_prefix,
       left(e.key_points::text, ${JSON_IV_STAMP_PREFIX_LEN}) AS key_points_prefix,
       left(e.action_items::text, ${JSON_IV_STAMP_PREFIX_LEN}) AS action_items_prefix
FROM recordings r
LEFT JOIN transcriptions t ON t.recording_id = r.id
LEFT JOIN ai_enhancements e ON e.recording_id = r.id
WHERE r.deleted_at IS NULL AND NOT r.is_trash`

// Phase 2 of refresh(): full metadata (title/summary/key points/action items/transcript
// descriptors), for exactly the ids phase 1 found new or changed -- `AND r.id = ANY($1)`
// is always present, never run for the whole corpus at once (see refresh()).
//
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
WHERE r.deleted_at IS NULL AND NOT r.is_trash AND r.id = ANY($1)`

// Joins back to recordings (not just a bare `WHERE recording_id = ANY($1)`) so a stray or
// spoofed id can't pull another user's/a trashed/a deleted recording's transcript text.
const TRANSCRIPTS_QUERY = `
SELECT t.recording_id, t.source, t.text
FROM transcriptions t
JOIN recordings r ON r.id = t.recording_id
WHERE t.recording_id = ANY($1) AND r.deleted_at IS NULL AND NOT r.is_trash`

interface Snapshot {
  /** Public contract: same order every caller sees (`startedAt` descending). */
  recordings: Recording[]
  /** Same recordings, by id -- for O(1) reuse lookups on the next refresh. */
  recordingsById: Map<string, Recording>
  normalizedFieldsById: Map<string, NormalizedCheapFields>
  /** Per-recording change stamp this snapshot was built with -- see `stampFor()`. */
  stampsById: Map<string, string>
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
        try {
          texts.push({ source: row.source, text: decrypt(row.text, this.encryptionKey) })
        } catch (err) {
          // Same reasoning as buildRecording(): one undecryptable transcript
          // row (bad GCM tag) must not fail the whole batch. Log only the
          // recording id/source + a content-free error label, and yield no
          // text for that source instead of throwing.
          console.error(
            `[riffado-mcp] skipping transcript for recording ${row.recording_id} ` +
              `(source ${row.source}): ${safeErrorLabel(err)}`,
          )
        }
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

  /**
   * Two-phase refresh -- see the file header and `docs/architecture.md`.
   *
   * Phase 1 (`STAMP_QUERY`) computes every current recording's change stamp
   * cheaply (IV prefixes, flags, transcript ids -- never full ciphertext)
   * and, by comparing each one to the previous refresh's stamp for that id
   * (`previous.stampsById`), decides which ids are new or changed.
   *
   * Phase 2 (`METADATA_QUERY`, `WHERE r.id = ANY($1)`) fetches full metadata
   * -- and only now touches any ciphertext -- for exactly those ids, and is
   * skipped entirely when nothing changed. Every other id is carried
   * forward from `previous` **by reference**: no decrypt, no
   * re-normalize. A recording that no longer appears in phase 1's results
   * (trashed, deleted, or gone) is simply not carried forward; one that
   * disappears between phase 1 and phase 2 (a rare race, e.g. deleted
   * mid-refresh) is dropped the same way, not left half-built.
   *
   * The very first refresh (`this.cache` still `null` -- a cold start, or
   * right after `invalidate()`, which drops the stamps along with
   * everything else) has nothing to compare phase 1's stamps against, so
   * every id counts as changed and phase 2 fetches the whole corpus --
   * functionally the old single-query refresh, plus phase 1's cheap round
   * trip.
   */
  private async refresh(): Promise<Snapshot> {
    const start = Date.now()
    const previous = this.cache

    const stampParams: string[] = []
    let stampQuery = STAMP_QUERY
    if (this.userId) {
      stampParams.push(this.userId)
      stampQuery += ` AND r.user_id = $${stampParams.length}`
    }
    stampQuery += " ORDER BY r.start_time DESC"
    const stampResult = await this.pool.query<StampRow>(stampQuery, stampParams)

    // Group phase-1 rows by recording id, preserving first-seen order -- the query's ORDER
    // BY (startedAt descending) already puts them in the order the public `recordings`
    // array must keep, regardless of which ids end up reused vs. rebuilt below.
    const stampRowsById = new Map<string, StampRow[]>()
    const order: string[] = []
    for (const row of stampResult.rows) {
      const group = stampRowsById.get(row.id)
      if (group) {
        group.push(row)
      } else {
        stampRowsById.set(row.id, [row])
        order.push(row.id)
      }
    }

    const stampsById = new Map<string, string>()
    const toFetch: string[] = []
    for (const id of order) {
      const stamp = this.stampFor(stampRowsById.get(id)!)
      stampsById.set(id, stamp)
      if (!previous || previous.stampsById.get(id) !== stamp) {
        toFetch.push(id)
      }
    }

    const rebuiltById = new Map<string, Recording>()
    if (toFetch.length > 0) {
      const params: unknown[] = [toFetch]
      let query = METADATA_QUERY
      if (this.userId) {
        params.push(this.userId)
        query += ` AND r.user_id = $${params.length}`
      }
      query += " ORDER BY r.start_time DESC"
      const result = await this.pool.query<MetaRow>(query, params)

      const rowsById = new Map<string, MetaRow[]>()
      for (const row of result.rows) {
        const group = rowsById.get(row.id)
        if (group) {
          group.push(row)
        } else {
          rowsById.set(row.id, [row])
        }
      }
      for (const [id, rows] of rowsById) {
        try {
          rebuiltById.set(id, this.buildRecording(rows))
        } catch (err) {
          // A bad GCM tag (decipher.final() throws) or invalid JSON in
          // key_points/action_items for one recording must not break the
          // whole refresh. Log only the id + a content-free label -- never the
          // plaintext/ciphertext -- and skip that recording; it simply
          // won't appear in this refresh (same as a deleted/trashed one).
          console.error(`[riffado-mcp] skipping recording ${id}: ${safeErrorLabel(err)}`)
        }
      }
    }

    const fetched = new Set(toFetch)
    const recordings: Recording[] = []
    const recordingsById = new Map<string, Recording>()
    const normalizedFieldsById = new Map<string, NormalizedCheapFields>()
    let reused = 0

    for (const id of order) {
      const rebuilt = rebuiltById.get(id)
      let rec: Recording | undefined
      let normalized: NormalizedCheapFields | undefined
      if (rebuilt) {
        rec = rebuilt
        normalized = normalizedCheapFieldsFor(rec)
      } else if (!fetched.has(id)) {
        // Only unchanged ids reuse the previous snapshot. A changed id that
        // failed to rebuild (corrupt ciphertext/JSON) or vanished between
        // phase 1 and phase 2 must not fall back to its stale copy.
        rec = previous?.recordingsById.get(id)
        normalized = previous?.normalizedFieldsById.get(id)
        if (rec && normalized) {
          reused++
        }
      }
      if (!rec || !normalized) {
        // Failed to rebuild or vanished between phase 1 and phase 2. Forget
        // its stamp too, so the next refresh fetches it again instead of
        // treating it as "unchanged" and leaving it out until the row changes.
        stampsById.delete(id)
        continue
      }
      recordings.push(rec)
      recordingsById.set(id, rec)
      normalizedFieldsById.set(id, normalized)
    }

    console.error(
      `[riffado-mcp] store refreshed: ${recordings.length} recording(s), ${toFetch.length} ` +
        `fetched (${reused} reused unchanged) in ${Date.now() - start}ms`,
    )
    return { recordings, recordingsById, normalizedFieldsById, stampsById }
  }

  /** Decrypts + normalizes one recording from its own metadata-query rows
   * (one row per transcript source, at least one row even with none). */
  private buildRecording(rows: MetaRow[]): Recording {
    const first = rows[0]
    const durationMs = first.duration ?? 0
    const summary = first.summary ? decrypt(first.summary, this.encryptionKey) : ""
    const rec: Recording = {
      id: first.id,
      userId: first.user_id,
      title: titleOrFallback(decrypt(first.filename, this.encryptionKey), first.id),
      startedAt: timestampToIsoUtc(first.start_time),
      durationMs,
      duration: formatDuration(durationMs),
      summary: summary || undefined,
      keyPoints: decryptJson(first.key_points, this.encryptionKey).map(flattenListItem),
      actionItems: decryptJson(first.action_items, this.encryptionKey).map(flattenListItem),
      transcripts: [],
      url: this.appUrl ? `${this.appUrl.replace(/\/+$/, "")}/recordings/${first.id}` : undefined,
    }

    for (const row of rows) {
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

    return rec
  }

  /**
   * Cheap per-recording change stamp, built from phase 1's prefix-only
   * rows -- no decryption, and (thanks to `ivStampOf`/`jsonIvStampOf` only
   * ever looking at a fixed-length prefix, see their doc comments) no need
   * for the full ciphertext either. Built from: the IV segment of each
   * encrypted field (any re-encryption draws a fresh IV, so a changed IV
   * always means changed content), `is_trash`/`deleted_at`/`updated_at`,
   * and the set of transcript `(id, source)` pairs with their count (so an
   * added or removed transcript source is caught even though nothing else
   * on the recording changed). Equal stamps across two refreshes are the
   * signal that lets `refresh()` reuse the previous cache entry verbatim,
   * skipping phase 2 for that recording entirely.
   */
  private stampFor(rows: StampRow[]): string {
    const first = rows[0]
    const transcriptIds = rows
      .filter((r) => r.transcript_id !== null)
      .map((r) => `${r.transcript_id}:${r.source}`)
      .sort()

    return JSON.stringify([
      ivStampOf(first.filename_prefix),
      ivStampOf(first.summary_prefix),
      jsonIvStampOf(first.key_points_prefix),
      jsonIvStampOf(first.action_items_prefix),
      first.is_trash,
      first.deleted_at,
      first.updated_at,
      transcriptIds.length,
      transcriptIds,
    ])
  }
}
