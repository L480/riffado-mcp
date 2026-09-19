/** Domain types for decrypted Riffado data. Never hold ciphertext past `crypto.ts`. */

/**
 * A transcript's cheap facts, without its text. `RecordingStore.get()`
 * returns these; the text itself is loaded on demand via
 * `RecordingStore.getTranscripts()`.
 */
export interface TranscriptDescriptor {
  source: string
  provider: string
  model: string
  language?: string
  /**
   * Approximate decrypted character count, derived from the ciphertext's hex
   * length (AES-GCM has no padding, so ciphertext length == plaintext UTF-8
   * byte length) without decrypting or fetching the transcript text itself.
   * Exact for ASCII text; a slight overestimate for multi-byte UTF-8 (e.g.
   * German umlauts). Legacy unencrypted rows get their exact length.
   */
  textLength: number
}

/** One transcript's decrypted text, as returned by `RecordingStore.getTranscripts()`. */
export interface TranscriptText {
  source: string
  text: string
}

export interface Recording {
  id: string
  userId: string
  /** Decrypted filename; empty string when not set. */
  title: string
  /** ISO 8601 UTC, e.g. `2026-09-18T14:03:00.000Z`. */
  startedAt: string
  durationMs: number
  /** `H:MM:SS` */
  duration: string
  summary?: string
  keyPoints: string[]
  actionItems: string[]
  /** Descriptors only -- no transcript text. See `RecordingStore.getTranscripts()`. */
  transcripts: TranscriptDescriptor[]
  /** Deep link into the Riffado app, when `RIFFADO_APP_URL` is configured. */
  url?: string
}

export interface ActionItemEntry {
  text: string
  recordingId: string
  recordingTitle: string
  startedAt: string
}
