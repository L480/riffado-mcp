/** Domain types for decrypted Riffado data. Never hold ciphertext past `crypto.ts`. */

export interface Transcript {
  source: string
  provider: string
  model: string
  language?: string
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
  transcripts: Transcript[]
  /** Deep link into the Riffado app, when `RIFFADO_APP_URL` is configured. */
  url?: string
}

export interface ActionItemEntry {
  text: string
  recordingId: string
  recordingTitle: string
  startedAt: string
}
