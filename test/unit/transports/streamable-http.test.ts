import http from "http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { afterEach, describe, expect, it } from "vitest"
import { StreamableHttpServer } from "../../../src/transports/streamable-http.js"

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

  it("provides a health check that is public even with auth configured", async () => {
    ;({ server } = await startServer({ authToken: "secret" }))
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/health")
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe("ok")
  })

  it("reports DB reachability and cached recording count via the healthCheck callback", async () => {
    ;({ server } = await startServer({
      healthCheck: async () => ({ database: { reachable: true }, recordings: { cached: 3 } }),
    }))
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/health")
    const body = JSON.parse(res.body)
    expect(body.database.reachable).toBe(true)
    expect(body.recordings.cached).toBe(3)
  })

  it("routes MCP requests posted to /mcp when unauthenticated (no authToken configured)", async () => {
    ;({ server } = await startServer())
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(res.statusCode).not.toBe(404)
  })

  it("requires authentication on /mcp when authToken is configured", async () => {
    ;({ server } = await startServer({ authToken: "secret" }))
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
    ;({ server } = await startServer({ authToken: "secret", authHeaderName: "x-api-token" }))
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
    ;({ server } = await startServer({ authToken: "secret", authHeaderName: "x-api-token" }))
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-token": "secret" },
      body: "{}",
    })
    expect(res.statusCode).not.toBe(401)
  })

  it("accepts a correct raw bearer token", async () => {
    ;({ server } = await startServer({ authToken: "secret" }))
    // @ts-expect-error private property access for test
    const port = (server.server as http.Server).address().port
    const res = await request(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
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
      headers: { "Content-Type": "application/json", "mcp-session-id": "does-not-exist" },
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
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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
      headers: { "mcp-session-id": sessionId },
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
})
