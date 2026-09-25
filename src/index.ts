#!/usr/bin/env node
import { loadConfig } from "./config.js"
import { createPool } from "./riffado/db.js"
import { parseEncryptionKey } from "./riffado/crypto.js"
import { RecordingStore } from "./riffado/store.js"
import { createRiffadoServer } from "./utils/server-factory.js"
import { StdioTransportServer } from "./transports/stdio.js"
import { StreamableHttpServer } from "./transports/streamable-http.js"
import type { RiffadoTransportServer } from "./transports/base.js"

async function main(): Promise<void> {
  const config = loadConfig()
  const pool = createPool({
    connectionString: config.DATABASE_URL,
    statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  })

  const store = new RecordingStore({
    pool,
    encryptionKey: parseEncryptionKey(config.ENCRYPTION_KEY),
    cacheTtlMs: config.CACHE_TTL_MS,
    userId: config.RIFFADO_USER_ID,
    appUrl: config.RIFFADO_APP_URL,
  })

  let transport: RiffadoTransportServer

  if (config.TRANSPORT === "http") {
    // loadConfig() already rejects TRANSPORT=http without a token; this
    // narrows the type and keeps the invariant local.
    const authToken = config.HTTP_AUTH_TOKEN
    if (!authToken) {
      throw new Error("HTTP_AUTH_TOKEN is required when TRANSPORT=http")
    }
    transport = new StreamableHttpServer({
      port: config.HTTP_PORT,
      host: config.HTTP_HOST,
      authToken,
      authHeaderName: config.HTTP_AUTH_HEADER_NAME,
      oauthEnabled: config.HTTP_OAUTH_ENABLED,
      publicUrl: config.HTTP_PUBLIC_URL,
      oauthStateFile: config.HTTP_OAUTH_STATE_FILE,
      oauthAllowedRedirectHosts: config.HTTP_OAUTH_ALLOWED_REDIRECT_HOSTS,
      trustProxy: config.HTTP_TRUST_PROXY,
      sessionTimeoutMs: config.HTTP_SESSION_TIMEOUT_MS,
      createServer: () => createRiffadoServer(store),
      healthCheck: async () => {
        let reachable = true
        try {
          await pool.query("SELECT 1")
        } catch {
          reachable = false
        }
        return { database: { reachable }, recordings: { cached: store.getCachedCount() ?? null } }
      },
    })
  } else {
    transport = new StdioTransportServer(createRiffadoServer(store))
  }

  const shutdown = async (signal: string) => {
    console.error(`Received ${signal}, shutting down...`)
    try {
      await transport.stop()
      await pool.end()
      process.exit(0)
    } catch (error) {
      console.error("Error during shutdown:", error)
      process.exit(1)
    }
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

  await transport.start()
}

main().catch((error) => {
  console.error("Fatal error starting riffado-mcp:", error)
  process.exit(1)
})
