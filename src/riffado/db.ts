/**
 * Single `pg.Pool`, pinned strictly read-only.
 *
 * `options: "-c default_transaction_read_only=on"` is the write guard: every
 * session on this pool starts with `default_transaction_read_only=on`, so
 * Postgres itself rejects any `INSERT`/`UPDATE`/`DELETE` — a bug or prompt
 * injection in a tool handler cannot mutate Riffado. Only parameterized
 * `SELECT`s are ever run against this pool; never build SQL from strings.
 */
import pg from "pg"

// `timestamp` (no tz) columns (OID 1114) come back as plain strings instead
// of pg's default `Date` parsing, which assumes the *server's* local
// timezone. Riffado stores `start_time` as UTC-without-tz, so we parse it
// ourselves in `store.ts` and must not let pg silently reinterpret it.
pg.types.setTypeParser(1114, (value: string) => value)

export interface DbConfig {
  connectionString: string
  statementTimeoutMs: number
  maxConnections?: number
}

export function createPool(config: DbConfig): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    options: "-c default_transaction_read_only=on",
    statement_timeout: config.statementTimeoutMs,
    max: config.maxConnections ?? 4,
    application_name: "riffado-mcp",
  })

  // An idle client can error out from under us (e.g. the DB restarting or
  // dropping the connection) — pg.Pool documents that without a listener
  // here, that error is an uncaught 'error' event and crashes the process.
  // Never log `error` itself or anything derived from the connection
  // string; just the message.
  pool.on("error", (err: Error) => {
    console.error(`[riffado-mcp] idle pg client error: ${err.message}`)
  })

  return pool
}

/** Converts a `YYYY-MM-DD HH:MM:SS[.ffffff]` (no tz) string to ISO 8601 UTC. */
export function timestampToIsoUtc(raw: string): string {
  return new Date(`${raw.replace(" ", "T")}Z`).toISOString()
}
