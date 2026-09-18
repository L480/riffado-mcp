/**
 * Adapted from L480/mcp-picnic (src/transports/streamable-http.ts). The
 * dual-mount (/mcp and /), dual-auth (shared token + OAuth), 404-on-expired-
 * session and trust-proxy behavior are copied from there because each is a
 * fixed bug — not a stylistic choice — for making Claude's connector work
 * reliably behind the Cloudflare Tunnel.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import express, { Request, Response, NextFunction } from "express"
import cors from "cors"
import { rateLimit } from "express-rate-limit"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js"
// Pulls in the `Request.auth` type augmentation from the SDK's bearer-auth middleware.
import "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js"
import { randomUUID, timingSafeEqual } from "crypto"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { RiffadoTransportServer } from "./base.js"
import { StaticTokenOAuthProvider } from "./oauth-provider.js"

export interface HealthDetails {
  database: { reachable: boolean }
  recordings: { cached: number | null }
}

export interface StreamableHttpServerOptions {
  port?: number
  host?: string
  authToken?: string
  authHeaderName?: string
  /** Wraps `authToken` in an OAuth 2.1 flow for OAuth-only clients (Claude's
   * custom connectors offer no static-token field). Defaults to `true`. */
  oauthEnabled?: boolean
  /** Public base URL the server is reachable at, used as the OAuth issuer. */
  publicUrl?: string
  /** Where the OAuth provider persists clients + tokens across restarts. */
  oauthStateFile?: string
  /** Express `trust proxy` setting; required behind the Cloudflare Tunnel. */
  trustProxy?: boolean | number | string
  corsOptions?: cors.CorsOptions
  requestTimeoutMs?: number
  maxRequestSizeBytes?: number
  enableRequestLogging?: boolean
  maxConcurrentSessions?: number
  /** 0 (default) disables idle expiry and keeps sessions open indefinitely. */
  sessionTimeoutMs?: number
  /** Builds one MCP server instance per session. */
  createServer: () => McpServer
  /** Backs `/health`'s DB-reachability + cached-recording-count fields. */
  healthCheck?: () => Promise<HealthDetails>
}

class SessionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message)
  }
}

/** MCP-over-HTTP transport using the SDK's Streamable HTTP transport, with a
 * static-token-or-OAuth auth layer in front of everything but `/health`. */
export class StreamableHttpServer implements RiffadoTransportServer {
  private readonly app: express.Application
  private server?: import("http").Server
  private readonly port: number
  private readonly host: string
  private readonly options: StreamableHttpServerOptions
  private readonly transports: Record<string, StreamableHTTPServerTransport> = {}
  private readonly sessionTimeouts = new Map<string, NodeJS.Timeout>()
  private oauthProvider?: StaticTokenOAuthProvider
  private resourceMetadataUrl?: string

  constructor(options: StreamableHttpServerOptions) {
    this.options = {
      port: 3000,
      host: "localhost",
      authHeaderName: "x-mcp-token",
      oauthEnabled: true,
      requestTimeoutMs: 10000,
      maxRequestSizeBytes: 1024 * 1024 * 10,
      enableRequestLogging: true,
      maxConcurrentSessions: 100,
      sessionTimeoutMs: 0,
      ...options,
    }
    this.port = this.options.port!
    this.host = this.options.host!
    this.app = express()

    this.setupMiddleware()
    this.setupRoutes()
  }

  private setupMiddleware(): void {
    // Honour X-Forwarded-* headers behind the Cloudflare Tunnel. Without
    // this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
    this.app.set("trust proxy", this.options.trustProxy ?? false)

    if (this.options.enableRequestLogging) {
      this.app.use((req: Request, res: Response, next: NextFunction) => {
        const start = Date.now()
        console.error(`[${new Date().toISOString()}] ${req.method} ${req.url} - ${req.ip}`)
        res.on("finish", () => {
          console.error(
            `[${new Date().toISOString()}] ${req.method} ${req.url} - ${res.statusCode} - ${Date.now() - start}ms`,
          )
        })
        next()
      })
    }

    this.app.use(
      rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 300,
        standardHeaders: true,
        legacyHeaders: false,
      }),
    )

    // CORS before auth so OAuth discovery endpoints and preflight requests
    // are handled before auth kicks in.
    this.app.use(
      cors(
        this.options.corsOptions || {
          origin: "*",
          methods: ["GET", "POST", "DELETE"],
          allowedHeaders: ["Content-Type", "MCP-Session-ID", "Authorization"],
          exposedHeaders: ["MCP-Session-ID", "WWW-Authenticate"],
        },
      ),
    )

    this.setupOAuth()

    if (this.options.authToken) {
      this.app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.path === "/health") {
          return next()
        }

        const headerName = this.options.authHeaderName ?? "x-mcp-token"
        const headerToken = req.header(headerName)
        const authorizationHeader = req.header("authorization")
        const bearerToken =
          typeof authorizationHeader === "string" && authorizationHeader.startsWith("Bearer ")
            ? authorizationHeader.slice(7)
            : undefined

        const staticTokenValid =
          this.compareAuthTokens(headerToken) ||
          (bearerToken !== undefined && this.compareAuthTokens(bearerToken))
        if (staticTokenValid) {
          return next()
        }

        if (this.oauthProvider && bearerToken !== undefined) {
          const authInfo = this.oauthProvider.getValidAccessToken(bearerToken)
          if (authInfo) {
            req.auth = authInfo
            return next()
          }
        }

        // RFC 9728: point compatible clients at OAuth discovery.
        if (this.resourceMetadataUrl) {
          res.setHeader(
            "WWW-Authenticate",
            `Bearer resource_metadata="${this.resourceMetadataUrl}"`,
          )
        }

        return res.status(401).json({
          error: "Unauthorized",
          message: "Missing or invalid authentication token. Provide a valid auth header.",
        })
      })
    } else {
      console.error(
        "WARNING: HTTP_AUTH_TOKEN is not set — the HTTP transport is running UNAUTHENTICATED. " +
          "Set HTTP_AUTH_TOKEN before exposing this server.",
      )
    }

    this.app.use((_req: Request, res: Response, next: NextFunction) => {
      const timeout = setTimeout(() => {
        if (!res.headersSent) {
          res.status(408).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Request timeout" },
            id: null,
          })
        }
      }, this.options.requestTimeoutMs)
      res.on("finish", () => clearTimeout(timeout))
      res.on("close", () => clearTimeout(timeout))
      next()
    })

    this.app.use(express.json({ limit: this.options.maxRequestSizeBytes }))

    this.app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        return next(error)
      }
      console.error("HTTP middleware error:", error)
      const isTooLarge = (error as { type?: string })?.type === "entity.too.large"
      res.status(isTooLarge ? 413 : 500).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: isTooLarge ? "Request body too large" : "Internal server error",
        },
        id: null,
      })
    })
  }

  private compareAuthTokens(token: string | undefined): boolean {
    if (!this.options.authToken || typeof token !== "string") {
      return false
    }
    const provided = Buffer.from(token)
    const expected = Buffer.from(this.options.authToken)
    if (provided.length !== expected.length) {
      return false
    }
    return timingSafeEqual(provided, expected)
  }

  private resolvePublicBaseUrl(): string {
    if (this.options.publicUrl) {
      return this.options.publicUrl.replace(/\/+$/, "")
    }
    return `http://${this.host}:${this.port}`
  }

  /**
   * Mounts the OAuth 2.1 authorization server wrapping the shared token.
   * Skipped when there's no shared token or OAuth is disabled. If a valid
   * issuer URL can't be formed, OAuth is disabled with an actionable log
   * message while shared-token auth keeps working.
   */
  private setupOAuth(): void {
    if (!this.options.authToken || this.options.oauthEnabled === false) {
      return
    }

    const baseUrl = this.resolvePublicBaseUrl()

    try {
      const issuerUrl = new URL(baseUrl)
      if (
        issuerUrl.protocol !== "https:" &&
        issuerUrl.hostname !== "localhost" &&
        issuerUrl.hostname !== "127.0.0.1"
      ) {
        throw new Error(
          `OAuth issuer must be HTTPS (or localhost), got ${issuerUrl.protocol}//${issuerUrl.hostname}`,
        )
      }
      const resourceServerUrl = new URL("/mcp", issuerUrl)
      const authorizeEndpoint = new URL("/authorize", issuerUrl).href

      const provider = new StaticTokenOAuthProvider({
        authToken: this.options.authToken,
        authorizeEndpoint,
        resource: resourceServerUrl.href,
        serverName: "Riffado MCP",
        stateFile: this.options.oauthStateFile,
      })

      this.app.use(
        mcpAuthRouter({
          provider,
          issuerUrl,
          baseUrl: issuerUrl,
          resourceServerUrl,
          resourceName: "Riffado MCP",
        }),
      )

      this.oauthProvider = provider
      this.resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl)
      console.error(`OAuth authorization server enabled (issuer: ${issuerUrl.href})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `OAuth authorization server disabled: ${message}. Set HTTP_PUBLIC_URL to a public HTTPS URL ` +
          `to enable OAuth for clients such as Claude connectors. Shared-token authentication remains available.`,
      )
    }
  }

  private setupRoutes(): void {
    // Served at both "/mcp" and "/" so the connector works whether the
    // configured server URL includes the /mcp path or not — Claude posts
    // to the exact configured URL.
    this.app.all(["/mcp", "/"], async (req: Request, res: Response) => {
      try {
        await this.handleMCPRequest(req, res)
      } catch (error) {
        console.error("MCP request handler error:", error)
        if (!res.headersSent) {
          const statusCode = error instanceof SessionError ? error.statusCode : 500
          res.status(statusCode).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : "Internal error",
            },
            id: null,
          })
        }
      }
    })

    this.app.get("/health", async (_req: Request, res: Response) => {
      const base = {
        status: "ok",
        timestamp: new Date().toISOString(),
        sessions: this.getActiveSessions().length,
      }
      if (!this.options.healthCheck) {
        res.status(200).json(base)
        return
      }
      try {
        const details = await this.options.healthCheck()
        res.status(200).json({ ...base, ...details })
      } catch (error) {
        res.status(200).json({
          ...base,
          status: "degraded",
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }

  private async handleMCPRequest(req: Request, res: Response): Promise<void> {
    switch (req.method) {
      case "POST":
        await this.handlePostRequest(req, res)
        break
      case "GET":
        await this.handleGetOrDeleteRequest(req, res)
        break
      case "DELETE":
        await this.handleDeleteRequest(req, res)
        break
      default:
        res.setHeader("Allow", "POST, GET, DELETE")
        res.status(405).json({ error: "Method Not Allowed" })
    }
  }

  private async handlePostRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.header("mcp-session-id")
    if (isInitializeRequest(req.body)) {
      const transport = await this.createNewSession()
      await transport.handleRequest(req, res, req.body)
      return
    }

    if (!sessionId) {
      throw new SessionError("Missing mcp-session-id header", 400)
    }
    const transport = this.transports[sessionId]
    if (!transport) {
      // 404 (not 400) tells spec-compliant clients, including Claude's
      // connector, to silently re-initialize instead of surfacing a hard
      // "disconnected" error that needs a manual reconnect.
      throw new SessionError("Session not found or expired", 404)
    }
    this.refreshSessionTimeout(sessionId)
    await transport.handleRequest(req, res, req.body)
  }

  private async handleGetOrDeleteRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.header("mcp-session-id")
    if (!sessionId) {
      throw new SessionError("Missing mcp-session-id header", 400)
    }
    const transport = this.transports[sessionId]
    if (!transport) {
      throw new SessionError("Session not found or expired", 404)
    }
    this.refreshSessionTimeout(sessionId)
    await transport.handleRequest(req, res)
  }

  private async handleDeleteRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.header("mcp-session-id")
    if (!sessionId) {
      throw new SessionError("Missing mcp-session-id header", 400)
    }
    const transport = this.transports[sessionId]
    if (!transport) {
      throw new SessionError("Session not found or expired", 404)
    }
    await transport.handleRequest(req, res, req.body)
    this.cleanupSession(sessionId)
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, this.host, () => {
        console.error(`riffado-mcp HTTP server running on http://${this.host}:${this.port}/mcp`)
        resolve()
      })
      this.server.on("error", (err: Error) => {
        console.error(`Server error: ${err.message}`)
      })
    })
  }

  public async stop(): Promise<void> {
    console.error("Stopping HTTP server...")
    const sessionIds = this.getActiveSessions()
    await Promise.allSettled(sessionIds.map((id) => this.cleanupSession(id)))

    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Server shutdown timed out")), 10000)
        this.server!.close((err?: Error) => {
          clearTimeout(timeout)
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
    }
    console.error("HTTP server stopped")
  }

  public async createNewSession(): Promise<StreamableHTTPServerTransport> {
    if (Object.keys(this.transports).length >= this.options.maxConcurrentSessions!) {
      throw new SessionError("Max concurrent sessions reached", 503)
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        this.transports[sid] = transport
        this.setupSessionTimeout(sid)
      },
    })

    transport.onclose = () => {
      if (transport.sessionId) {
        this.cleanupSession(transport.sessionId)
      }
    }

    const server = this.options.createServer()
    await server.connect(transport)
    return transport
  }

  public getTransport(sessionId: string): StreamableHTTPServerTransport | undefined {
    return this.transports[sessionId]
  }

  public cleanupSession(sessionId: string): void {
    const transport = this.transports[sessionId]
    if (transport) {
      delete this.transports[sessionId]
      const timeout = this.sessionTimeouts.get(sessionId)
      if (timeout) {
        clearTimeout(timeout)
        this.sessionTimeouts.delete(sessionId)
      }
      transport.close()
    }
  }

  private setupSessionTimeout(sessionId: string): void {
    if (!this.options.sessionTimeoutMs || this.options.sessionTimeoutMs <= 0) {
      return
    }
    const timeout = setTimeout(() => this.cleanupSession(sessionId), this.options.sessionTimeoutMs)
    this.sessionTimeouts.set(sessionId, timeout)
  }

  public refreshSessionTimeout(sessionId: string): void {
    this.sessionTimeouts.get(sessionId)?.refresh()
  }

  public getActiveSessions(): string[] {
    return Object.keys(this.transports)
  }
}
