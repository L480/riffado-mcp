import http from "http"
import fs from "fs"
import os from "os"
import path from "path"
import { createHash, randomBytes } from "crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { StreamableHttpServer } from "../../../src/transports/streamable-http.js"

function stubServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.0" }, { capabilities: {} })
}

interface HttpResult {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: string
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const form = (data: Record<string, string>): string =>
  Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&")

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

describe("StreamableHttpServer OAuth flow", () => {
  let server: StreamableHttpServer
  let port: number

  beforeEach(async () => {
    server = new StreamableHttpServer({
      port: 0,
      host: "127.0.0.1",
      authToken: "super-secret-token",
      publicUrl: "http://localhost",
      trustProxy: 1,
      enableRequestLogging: false,
      createServer: stubServer,
    })
    await server.start()
    // @ts-expect-error private property access for test
    const httpServer = server.server as http.Server
    port = (httpServer.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop().catch(() => {})
  })

  it("advertises protected resource metadata for OAuth discovery", async () => {
    const res = await request(port, "/.well-known/oauth-protected-resource/mcp")
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.resource).toBe("http://localhost/mcp")
  })

  it("advertises authorization server metadata with the expected endpoints", async () => {
    const res = await request(port, "/.well-known/oauth-authorization-server")
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.authorization_endpoint).toBe("http://localhost/authorize")
    expect(body.token_endpoint).toBe("http://localhost/token")
    expect(body.registration_endpoint).toBe("http://localhost/register")
    expect(body.code_challenge_methods_supported).toContain("S256")
  })

  it("returns 401 with a WWW-Authenticate challenge when unauthenticated", async () => {
    const res = await request(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(res.statusCode).toBe(401)
    expect(res.headers["www-authenticate"]).toContain("resource_metadata=")
  })

  it("renders the Riffado-branded login page", async () => {
    const registerRes = await request(port, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost/callback"],
        token_endpoint_auth_method: "none",
      }),
    })
    const client = JSON.parse(registerRes.body)
    const res = await request(
      port,
      `/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=http://localhost/callback&code_challenge=x&code_challenge_method=S256`,
    )
    expect(res.body).toContain("Connect to Riffado MCP")
  })

  it("escapes HTML in the client name on the login page", async () => {
    const registerRes = await request(port, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost/callback"],
        token_endpoint_auth_method: "none",
        client_name: "<script>alert(1)</script>",
      }),
    })
    const client = JSON.parse(registerRes.body)
    const res = await request(
      port,
      `/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=http://localhost/callback&code_challenge=x&code_challenge_method=S256`,
    )
    expect(res.body).not.toContain("<script>alert(1)</script>")
    expect(res.body).toContain("&lt;script&gt;")
  })

  it("never accepts the shared token from the /authorize query string", async () => {
    const registerRes = await request(port, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost/callback"],
        token_endpoint_auth_method: "none",
      }),
    })
    const client = JSON.parse(registerRes.body)
    const res = await request(
      port,
      `/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=http://localhost/callback&code_challenge=x&code_challenge_method=S256&mcp_auth_token=super-secret-token`,
    )
    expect(res.statusCode).toBe(200)
    expect(res.headers.location).toBeUndefined()
    expect(res.body).toContain('name="mcp_auth_token"')
  })

  it("completes the full authorization-code + PKCE flow and issues a usable token", async () => {
    const registerRes = await request(port, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost/callback"],
        token_endpoint_auth_method: "none",
        client_name: "Test Connector",
      }),
    })
    expect(registerRes.statusCode).toBe(201)
    const client = JSON.parse(registerRes.body)

    const codeVerifier = base64url(randomBytes(32))
    const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest())

    // Wrong token first: rejected, no redirect.
    const wrongRes = await request(port, "/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://localhost/callback",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        mcp_auth_token: "wrong-token",
      }),
    })
    expect(wrongRes.statusCode).toBe(401)
    expect(wrongRes.headers.location).toBeUndefined()

    const authorizeRes = await request(port, "/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://localhost/callback",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state: "xyz-state",
        mcp_auth_token: "super-secret-token",
      }),
    })
    expect(authorizeRes.statusCode).toBe(302)
    const location = new URL(authorizeRes.headers.location as string)
    expect(location.searchParams.get("state")).toBe("xyz-state")
    const code = location.searchParams.get("code")
    expect(code).toBeTruthy()

    const tokenRes = await request(port, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: codeVerifier,
        client_id: client.client_id,
        redirect_uri: "http://localhost/callback",
      }),
    })
    expect(tokenRes.statusCode).toBe(200)
    const tokens = JSON.parse(tokenRes.body)
    expect(tokens.token_type).toBe("Bearer")
    expect(tokens.access_token).toBeTruthy()
    expect(tokens.refresh_token).toBeTruthy()

    // The code is single-use: exchanging it again must fail.
    const reuseRes = await request(port, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: codeVerifier,
        client_id: client.client_id,
        redirect_uri: "http://localhost/callback",
      }),
    })
    expect(reuseRes.statusCode).toBeGreaterThanOrEqual(400)

    // redirect_uri mismatch during authorization must also be rejected —
    // re-run a fresh authorize+token pair to isolate the check.
    const authorizeRes2 = await request(port, "/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://localhost/callback",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        mcp_auth_token: "super-secret-token",
      }),
    })
    const code2 = new URL(authorizeRes2.headers.location as string).searchParams.get("code")
    const mismatchRes = await request(port, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        code: code2!,
        code_verifier: codeVerifier,
        client_id: client.client_id,
        redirect_uri: "http://localhost/different-callback",
      }),
    })
    expect(mismatchRes.statusCode).toBeGreaterThanOrEqual(400)

    // Use the first token pair to reach a protected endpoint.
    const protectedRes = await request(port, "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: "{}",
    })
    expect(protectedRes.statusCode).not.toBe(401)

    // Refresh rotation yields a new usable access token.
    const refreshRes = await request(port, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      }),
    })
    expect(refreshRes.statusCode).toBe(200)
    const refreshed = JSON.parse(refreshRes.body)
    expect(refreshed.access_token).toBeTruthy()
    expect(refreshed.access_token).not.toBe(tokens.access_token)

    const refreshedProtectedRes = await request(port, "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${refreshed.access_token}`,
      },
      body: "{}",
    })
    expect(refreshedProtectedRes.statusCode).not.toBe(401)
  })

  it("still accepts the raw shared token as a bearer token (backwards compatible)", async () => {
    const res = await request(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer super-secret-token" },
      body: "{}",
    })
    expect(res.statusCode).not.toBe(401)
  })

  it("routes MCP requests posted to the root path (not just /mcp)", async () => {
    const res = await request(port, "/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer super-secret-token" },
      body: "{}",
    })
    expect(res.statusCode).not.toBe(404)
  })

  it("handles the token endpoint behind a reverse proxy (X-Forwarded-For)", async () => {
    const proxyHeaders = { "X-Forwarded-For": "203.0.113.7", "X-Forwarded-Proto": "https" }
    const registerRes = await request(port, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...proxyHeaders },
      body: JSON.stringify({
        redirect_uris: ["http://localhost/callback"],
        token_endpoint_auth_method: "none",
      }),
    })
    const client = JSON.parse(registerRes.body)
    const codeVerifier = base64url(randomBytes(32))
    const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest())

    const authorizeRes = await request(port, "/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...proxyHeaders },
      body: form({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://localhost/callback",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        mcp_auth_token: "super-secret-token",
      }),
    })
    const code = new URL(authorizeRes.headers.location as string).searchParams.get("code")

    const tokenRes = await request(port, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...proxyHeaders },
      body: form({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: codeVerifier,
        client_id: client.client_id,
        redirect_uri: "http://localhost/callback",
      }),
    })
    expect(tokenRes.statusCode).toBe(200)
    expect(JSON.parse(tokenRes.body).access_token).toBeTruthy()
  })
})

describe("StreamableHttpServer OAuth state persistence across restarts", () => {
  let stateFile: string

  beforeEach(() => {
    stateFile = path.join(
      os.tmpdir(),
      `riffado-mcp-oauth-state-${randomBytes(8).toString("hex")}.json`,
    )
  })

  afterEach(() => {
    fs.rmSync(stateFile, { force: true })
  })

  const startServer = async (): Promise<{ server: StreamableHttpServer; port: number }> => {
    const server = new StreamableHttpServer({
      port: 0,
      host: "127.0.0.1",
      authToken: "super-secret-token",
      publicUrl: "http://localhost",
      trustProxy: 1,
      enableRequestLogging: false,
      oauthStateFile: stateFile,
      createServer: stubServer,
    })
    await server.start()
    // @ts-expect-error private property access for test
    const httpServer = server.server as http.Server
    return { server, port: (httpServer.address() as { port: number }).port }
  }

  it("keeps a previously issued access token valid after the server restarts", async () => {
    const { server: server1, port: port1 } = await startServer()

    const registerRes = await request(port1, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost/callback"],
        token_endpoint_auth_method: "none",
        client_name: "Test Connector",
      }),
    })
    const client = JSON.parse(registerRes.body)
    const codeVerifier = base64url(randomBytes(32))
    const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest())

    const authorizeRes = await request(port1, "/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://localhost/callback",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        mcp_auth_token: "super-secret-token",
      }),
    })
    const code = new URL(authorizeRes.headers.location as string).searchParams.get("code")

    const tokenRes = await request(port1, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: codeVerifier,
        client_id: client.client_id,
        redirect_uri: "http://localhost/callback",
      }),
    })
    const tokens = JSON.parse(tokenRes.body)
    expect(tokens.access_token).toBeTruthy()

    await server1.stop()
    const { server: server2, port: port2 } = await startServer()

    try {
      const protectedRes = await request(port2, "/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokens.access_token}`,
        },
        body: "{}",
      })
      expect(protectedRes.statusCode).not.toBe(401)

      const refreshRes = await request(port2, "/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: client.client_id,
        }),
      })
      expect(refreshRes.statusCode).toBe(200)
      expect(JSON.parse(refreshRes.body).access_token).toBeTruthy()
    } finally {
      await server2.stop()
    }
  })

  it("tolerates a corrupt state file instead of failing to start", async () => {
    fs.writeFileSync(stateFile, "{not valid json")
    const { server, port } = await startServer()
    try {
      const res = await request(port, "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer super-secret-token" },
        body: "{}",
      })
      expect(res.statusCode).not.toBe(401)
    } finally {
      await server.stop()
    }
  })
})
