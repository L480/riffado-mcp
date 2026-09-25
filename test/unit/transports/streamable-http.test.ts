import http from "http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StreamableHttpServer } from "../../../src/transports/streamable-http.js"

const TOKEN = "test-shared-secret-test-shared-secret"
const AUTH = { Authorization: `Bearer ${TOKEN}` }

function stubServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.0" }, { capabilities: {} })
}

interface HttpResult {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: string
}

function request(
  port: number,
  reqPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        let data = ""
        response.on("data", (chunk) => (data += chunk))
        response.on("end", () =>
          resolve({ statusCode: response.statusCode!, headers: response.headers, body: data }),
        )
      },
    )
    req.on("error", reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

async function startServer(
  overrides: Partial<ConstructorParameters<typeof StreamableHttpServer>[0]> = {},
): Promise<{ server: StreamableHttpServer; port: number }> {
  const server = new StreamableHttpServer({
    port: 0,
    host: "127.0.0.1",
    authToken: TOKEN,
    enableRequestLogging: false,
    createServer: stubServer,
    ...overrides,
  })
  await server.start()
  // @ts-expect-error private property access for test
  const httpServer = server.server as http.Server
  return { server, port: (httpServer.address() as { port: number }).port }
}

describe("StreamableHttpServer", () => {
  let server: StreamableHttpServer

  afterEach(async () => {
    if (server) await server.stop().catch(() => {})
  })

  it("refuses to construct without an auth token (no unauthenticated mode)", () => {
    expect(
      () =>
        new StreamableHttpServer({
          authToken: "",
          enableRequestLogging: false,
          createServer: stubServer,
        }),
    ).toThrow(/authToken/)
    expect(
      () =>
        new StreamableHttpServer({
          enableRequestLogging: false,
          createServer: stubServer,
        } as unknown as ConstructorParameters<typeof StreamableHttpServer>[0]),
    ).toThrow(/authToken/)
  })

  it("rejects unauthenticated requests on the root MCP mount too", async () => {
    ;({ server } = await startServer())
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(res.statusCode).toBe(401)
  })

  it("provides a health check that is public", async () => {
    ;({ server } = await startServer())
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/health")
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe("ok")
  })

  it("sets X-Content-Type-Options: nosniff on every response", async () => {
    ;({ server } = await startServer())
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    expect((await request(port, "/health")).headers["x-content-type-options"]).toBe("nosniff")
    const unauthed = await request(port, "/mcp", { method: "POST", body: "{}" })
    expect(unauthed.statusCode).toBe(401)
    expect(unauthed.headers["x-content-type-options"]).toBe("nosniff")
  })

  it("exposes only status+timestamp on /health, nothing else", async () => {
    ;({ server } = await startServer({
      healthCheck: async () => ({ database: { reachable: true }, recordings: { cached: 3 } }),
    }))
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/health")
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(Object.keys(body).sort()).toEqual(["status", "timestamp"])
    expect(body.sessions).toBeUndefined()
    expect(body.database).toBeUndefined()
    expect(body.recordings).toBeUndefined()
  })

  it("reports DB reachability and cached recording count via /health/details", async () => {
    ;({ server } = await startServer({
      healthCheck: async () => ({ database: { reachable: true }, recordings: { cached: 3 } }),
    }))
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/health/details", { headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.database.reachable).toBe(true)
    expect(body.recordings.cached).toBe(3)
    expect(typeof body.sessions).toBe("number")
  })

  it("requires the same auth as /mcp on /health/details", async () => {
    ;({ server } = await startServer({
      healthCheck: async () => ({ database: { reachable: true }, recordings: { cached: 0 } }),
    }))
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port

    const unauthedRes = await request(port, "/health/details")
    expect(unauthedRes.statusCode).toBe(401)

    const authedRes = await request(port, "/health/details", {
      headers: AUTH,
    })
    expect(authedRes.statusCode).toBe(200)
  })

  it("routes authenticated MCP requests posted to /mcp", async () => {
    ;({ server } = await startServer())
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: "{}",
    })
    expect(res.statusCode).not.toBe(404)
  })

  it("requires authentication on /mcp", async () => {
    ;({ server } = await startServer())
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port

    const mcpRes = await request(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(mcpRes.statusCode).toBe(401)
    expect(mcpRes.body).toContain("Unauthorized")

    const healthRes = await request(port, "/health")
    expect(healthRes.statusCode).toBe(200)
  })

  it("rejects a wrong custom-header token", async () => {
    ;({ server } = await startServer({ authHeaderName: "x-api-token" }))
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-token": "wrong" },
      body: "{}",
    })
    expect(res.statusCode).toBe(401)
  })

  it("accepts a correct custom-header token", async () => {
    ;({ server } = await startServer({ authHeaderName: "x-api-token" }))
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-token": TOKEN },
      body: "{}",
    })
    expect(res.statusCode).not.toBe(401)
  })

  it("accepts a correct raw bearer token", async () => {
    ;({ server } = await startServer())
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: "{}",
    })
    expect(res.statusCode).not.toBe(401)
  })

  it("returns 404 (not 400) for an unknown/expired mcp-session-id", async () => {
    ;({ server } = await startServer())
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "mcp-session-id": "does-not-exist",
        ...AUTH,
      },
      body: "{}",
    })
    expect(res.statusCode).toBe(404)
  })

  it("returns 400 for a non-initialize POST with no session id at all", async () => {
    ;({ server } = await startServer())
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: "{}",
    })
    expect(res.statusCode).toBe(400)
  })

  it("routes to the MCP handler at the root path too", async () => {
    ;({ server } = await startServer())
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: "{}",
    })
    expect(res.statusCode).not.toBe(404)
  })

  it("creates a session on a real MCP initialize request and cleans it up on DELETE", async () => {
    ;({ server } = await startServer())
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port

    const initRes = await request(port, "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...AUTH,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }),
    })
    expect(initRes.statusCode).toBe(200)
    const sessionId = initRes.headers["mcp-session-id"] as string
    expect(sessionId).toBeTruthy()
    expect(server.getActiveSessions()).toContain(sessionId)

    const deleteRes = await request(port, "/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId, ...AUTH },
    })
    expect(deleteRes.statusCode).toBeLessThan(400)
    expect(server.getActiveSessions()).not.toContain(sessionId)
  })

  it("does not recurse when transport close fires onclose during session cleanup", async () => {
    ;({ server } = await startServer())
    const sessionId = "regression-session"
    const transport = {
      sessionId,
      closeCalls: 0,
      onclose: undefined as (() => void) | undefined,
      close() {
        this.closeCalls++
        this.onclose?.()
      },
    }
    transport.onclose = () => {
      if (transport.sessionId) server.cleanupSession(transport.sessionId)
    }
    // @ts-expect-error private property access for test
    server.transports[sessionId] = transport

    expect(() => server.cleanupSession(sessionId)).not.toThrow()
    expect(transport.closeCalls).toBe(1)
    expect(server.getActiveSessions()).not.toContain(sessionId)
  })

  async function initSession(port: number): Promise<string> {
    const initRes = await request(port, "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...AUTH,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }),
    })
    return initRes.headers["mcp-session-id"] as string
  }

  describe("idle session timeout", () => {
    it("closes an idle session once sessionTimeoutMs elapses", async () => {
      ;({ server } = await startServer({ sessionTimeoutMs: 50 }))
      // @ts-expect-error private property access for test
      const port = (server.server as http.Server).address().port
      const sessionId = await initSession(port)
      expect(server.getActiveSessions()).toContain(sessionId)

      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(server.getActiveSessions()).not.toContain(sessionId)
    })

    it("keeps a session open indefinitely when sessionTimeoutMs is explicitly 0", async () => {
      ;({ server } = await startServer({ sessionTimeoutMs: 0 }))
      // @ts-expect-error private property access for test
      const port = (server.server as http.Server).address().port
      const sessionId = await initSession(port)
      expect(server.getActiveSessions()).toContain(sessionId)

      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(server.getActiveSessions()).toContain(sessionId)
    })

    it("defaults to a 1h timeout (not 'never') when unset", async () => {
      ;({ server } = await startServer())
      // @ts-expect-error private property access for test
      expect(server.options.sessionTimeoutMs).toBe(3600000)
    })
  })

  it("logs only the request path, never the query string", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      ;({ server } = await startServer({ enableRequestLogging: true }))
      // @ts-expect-error private property access for test
      const port = (server.server as http.Server).address().port
      await request(port, "/health?code=leaky-code&state=leaky-state")
      const lines = log.mock.calls.map((args) => args.join(" "))
      expect(lines.some((l) => l.includes("GET /health"))).toBe(true)
      expect(lines.some((l) => l.includes("leaky-code") || l.includes("leaky-state"))).toBe(false)
    } finally {
      log.mockRestore()
    }
  })

  it("reports a degraded /health/details without leaking the internal error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      ;({ server } = await startServer({
        healthCheck: async () => {
          throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2")
        },
      }))
      // @ts-expect-error private property access for test
      const port = (server.server as http.Server).address().port
      const res = await request(port, "/health/details", { headers: AUTH })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.status).toBe("degraded")
      expect(body.error).toBe("Health check failed")
      expect(res.body).not.toContain("ECONNREFUSED")
      expect(res.body).not.toContain("hunter2")
      // The real error still reaches stderr for the operator.
      expect(log.mock.calls.flat().some((a) => String(a).includes("ECONNREFUSED"))).toBe(true)
    } finally {
      log.mockRestore()
    }
  })

  it("returns a generic message for non-session errors on the MCP route", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      ;({ server } = await startServer({
        createServer: () => {
          throw new Error("internal detail: /srv/secret/path")
        },
      }))
      // @ts-expect-error private property access for test
      const port = (server.server as http.Server).address().port
      const res = await request(port, "/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...AUTH,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.0" },
          },
        }),
      })
      expect(res.statusCode).toBe(500)
      expect(JSON.parse(res.body).error.message).toBe("Internal error")
      expect(res.body).not.toContain("/srv/secret/path")
    } finally {
      log.mockRestore()
    }
  })

  it("still returns SessionError messages to the client", async () => {
    ;({ server } = await startServer())
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": "nope", ...AUTH },
      body: "{}",
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error.message).toBe("Session not found or expired")
  })
})
