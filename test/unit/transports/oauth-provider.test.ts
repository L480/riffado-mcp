import fs from "fs"
import os from "os"
import path from "path"
import { createHash, randomBytes } from "crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Response } from "express"
import {
  DEFAULT_ALLOWED_REDIRECT_HOSTS,
  StaticTokenOAuthProvider,
  cspSourceFor,
  normalizeRedirectHost,
  redirectUriRejection,
} from "../../../src/transports/oauth-provider.js"
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js"
import {
  CustomOAuthError,
  InvalidScopeError,
  TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js"

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

function clientMetadata(
  name: string,
): Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at"> {
  return {
    redirect_uris: ["http://localhost/callback"],
    token_endpoint_auth_method: "none",
    client_name: name,
  }
}

const TOKEN = "secret"
const DAY = 24 * 60 * 60 * 1000

interface FakeResponse {
  statusCode: number
  headers: Record<string, string>
  body?: string
  location?: string
}

/** Minimal stand-in for the Express response `authorize()` writes to. */
function fakeResponse(req: {
  method: string
  body?: Record<string, unknown>
  query?: Record<string, unknown>
}): { res: Response; out: FakeResponse } {
  const out: FakeResponse = { statusCode: 200, headers: {} }
  const res = {
    req,
    status(code: number) {
      out.statusCode = code
      return res
    },
    setHeader(name: string, value: string) {
      out.headers[name.toLowerCase()] = value
      return res
    },
    send(body: string) {
      out.body = body
      return res
    },
    redirect(code: number, url: string) {
      out.statusCode = code
      out.location = url
    },
  }
  return { res: res as unknown as Response, out }
}

function newProvider(
  overrides: Partial<ConstructorParameters<typeof StaticTokenOAuthProvider>[0]> = {},
): StaticTokenOAuthProvider {
  return new StaticTokenOAuthProvider({
    authToken: TOKEN,
    authorizeEndpoint: "http://localhost/authorize",
    ...overrides,
  })
}

/** Runs register -> authorize (POST with the shared token) -> code exchange. */
async function issueTokens(provider: StaticTokenOAuthProvider, scopes: string[] = []) {
  const client = provider.clientsStore.registerClient!(
    clientMetadata("c"),
  ) as OAuthClientInformationFull
  const { res, out } = fakeResponse({ method: "POST", body: { mcp_auth_token: TOKEN } })
  await provider.authorize(
    client,
    { redirectUri: "http://localhost/callback", codeChallenge: "challenge", scopes },
    res,
  )
  const code = new URL(out.location!).searchParams.get("code")!
  const tokens = await provider.exchangeAuthorizationCode(client, code)
  return { client, tokens }
}

describe("StaticTokenOAuthProvider client registry cap", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("evicts only the oldest idle client once at maxClients, keeping the rest", () => {
    const provider = newProvider({ maxClients: 3 })
    const register = provider.clientsStore.registerClient!

    const c1 = register(clientMetadata("c1")) as OAuthClientInformationFull
    const c2 = register(clientMetadata("c2")) as OAuthClientInformationFull
    const c3 = register(clientMetadata("c3")) as OAuthClientInformationFull

    const c4 = register(clientMetadata("c4")) as OAuthClientInformationFull

    expect(provider.clientsStore.getClient(c1.client_id)).toBeUndefined()
    expect(provider.clientsStore.getClient(c2.client_id)).toBeDefined()
    expect(provider.clientsStore.getClient(c3.client_id)).toBeDefined()
    expect(provider.clientsStore.getClient(c4.client_id)).toBeDefined()
  })

  it("defaults maxClients to 100", () => {
    const provider = newProvider()
    const register = provider.clientsStore.registerClient!
    const clients: OAuthClientInformationFull[] = []
    for (let i = 0; i < 100; i++) {
      clients.push(register(clientMetadata(`c${i}`)) as OAuthClientInformationFull)
    }
    expect(provider.clientsStore.getClient(clients[0].client_id)).toBeDefined()
    register(clientMetadata("c100"))
    expect(provider.clientsStore.getClient(clients[0].client_id)).toBeUndefined()
    expect(provider.clientsStore.getClient(clients[1].client_id)).toBeDefined()
  })

  it("never evicts a client holding a live token, even if it is the oldest", async () => {
    const provider = newProvider({ maxClients: 3 })
    const { client: connector, tokens } = await issueTokens(provider)
    const register = provider.clientsStore.registerClient!

    // An anonymous flood of registrations must cycle through idle clients
    // only; the logged-in connector keeps working, including its refresh.
    for (let i = 0; i < 20; i++) {
      register(clientMetadata(`flood${i}`))
    }
    expect(provider.clientsStore.getClient(connector.client_id)).toBeDefined()
    await expect(
      provider.exchangeRefreshToken(connector, tokens.refresh_token!),
    ).resolves.toHaveProperty("access_token")
  })

  it("rejects registration once every client holds a live grant", async () => {
    const provider = newProvider({ maxClients: 2 })
    await issueTokens(provider)
    await issueTokens(provider)
    let thrown: unknown
    try {
      provider.clientsStore.registerClient!(clientMetadata("one-too-many"))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TooManyRequestsError)
  })

  it("treats a client whose grants all expired as evictable, and drops its tokens", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const provider = newProvider({
      maxClients: 1,
      accessTokenTtlSeconds: 60,
      refreshTokenTtlSeconds: 60,
    })
    const { client, tokens } = await issueTokens(provider)
    vi.setSystemTime(Date.now() + 120_000)

    const fresh = provider.clientsStore.registerClient!(
      clientMetadata("fresh"),
    ) as OAuthClientInformationFull
    expect(provider.clientsStore.getClient(client.client_id)).toBeUndefined()
    expect(provider.clientsStore.getClient(fresh.client_id)).toBeDefined()
    expect(provider.getValidAccessToken(tokens.access_token)).toBeUndefined()
  })

  it("protects a client with a pending authorization code", async () => {
    const provider = newProvider({ maxClients: 1 })
    const client = provider.clientsStore.registerClient!(
      clientMetadata("mid-login"),
    ) as OAuthClientInformationFull
    const { res } = fakeResponse({ method: "POST", body: { mcp_auth_token: TOKEN } })
    await provider.authorize(
      client,
      { redirectUri: "http://localhost/callback", codeChallenge: "c", scopes: [] },
      res,
    )
    expect(() => provider.clientsStore.registerClient!(clientMetadata("x"))).toThrow(
      TooManyRequestsError,
    )
    expect(provider.clientsStore.getClient(client.client_id)).toBeDefined()
  })
})

describe("StaticTokenOAuthProvider redirect URI allowlist", () => {
  function registerWith(redirectUris: string[], allowedRedirectHosts?: string[]) {
    const provider = newProvider({ allowedRedirectHosts })
    return () =>
      provider.clientsStore.registerClient!({
        ...clientMetadata("c"),
        redirect_uris: redirectUris,
      }) as OAuthClientInformationFull
  }

  function rejectionOf(fn: () => unknown): CustomOAuthError {
    try {
      fn()
    } catch (error) {
      return error as CustomOAuthError
    }
    throw new Error("expected registration to be rejected")
  }

  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://CLAUDE.AI/api/mcp/auth_callback",
    "http://localhost/callback",
    "http://localhost:6274/oauth/callback",
    "https://localhost:8443/cb",
    "http://127.0.0.1:33418/cb",
    "http://[::1]:33418/cb",
  ])("accepts %s by default", (uri) => {
    expect(registerWith([uri])().redirect_uris).toEqual([uri])
  })

  it.each([
    ["https://evil.example/cb", "not in HTTP_OAUTH_ALLOWED_REDIRECT_HOSTS"],
    ["https://claude.ai@evil.example/cb", "must not contain userinfo"],
    ["https://user:pw@claude.ai/cb", "must not contain userinfo"],
    ["https://claude.ai.evil.example/cb", "not in HTTP_OAUTH_ALLOWED_REDIRECT_HOSTS"],
    ["https://evil.example/claude.ai", "not in HTTP_OAUTH_ALLOWED_REDIRECT_HOSTS"],
    ["https://claude.ai./cb", "not in HTTP_OAUTH_ALLOWED_REDIRECT_HOSTS"],
    ["http://claude.ai/api/mcp/auth_callback", "must use https"],
    ["cursor://anysphere.cursor-retrieval/oauth/callback", "must use https"],
    ["javascript:alert(1)", "must use https"],
    ["https://claude.ai/cb#frag", "must not contain a fragment"],
    ["not a url", "not a valid URL"],
  ])("rejects %s", (uri, reason) => {
    const error = rejectionOf(registerWith([uri]))
    expect(error).toBeInstanceOf(CustomOAuthError)
    expect(error.errorCode).toBe("invalid_redirect_uri")
    expect(error.message).toContain(reason)
  })

  it("rejects the whole registration if any one redirect URI is not allowed", () => {
    const error = rejectionOf(
      registerWith(["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb"]),
    )
    expect(error.errorCode).toBe("invalid_redirect_uri")
  })

  it("rejects a registration with no redirect URIs", () => {
    expect(rejectionOf(registerWith([])).errorCode).toBe("invalid_redirect_uri")
  })

  it("honours a custom allowlist, loopback included only if listed", () => {
    expect(registerWith(["https://app.example.org/cb"], ["app.example.org"])()).toBeDefined()
    expect(rejectionOf(registerWith(["http://localhost/cb"], ["app.example.org"])).message).toMatch(
      /not in HTTP_OAUTH_ALLOWED_REDIRECT_HOSTS/,
    )
    // http stays reserved for loopback even when a host is allowlisted.
    expect(
      rejectionOf(registerWith(["http://app.example.org/cb"], ["app.example.org"])).message,
    ).toMatch(/must use https/)
  })

  it("does not evict anyone for a rejected registration", () => {
    const provider = newProvider({ maxClients: 1 })
    const existing = provider.clientsStore.registerClient!(
      clientMetadata("existing"),
    ) as OAuthClientInformationFull
    expect(() =>
      provider.clientsStore.registerClient!({
        ...clientMetadata("evil"),
        redirect_uris: ["https://evil.example/cb"],
      }),
    ).toThrow(CustomOAuthError)
    expect(provider.clientsStore.getClient(existing.client_id)).toBeDefined()
  })

  it("covers the Claude connector callback by default", () => {
    expect(
      redirectUriRejection(
        "https://claude.ai/api/mcp/auth_callback",
        new Set(DEFAULT_ALLOWED_REDIRECT_HOSTS.map(normalizeRedirectHost)),
      ),
    ).toBeUndefined()
  })
})

describe("normalizeRedirectHost", () => {
  it("lowercases and brackets IPv6", () => {
    expect(normalizeRedirectHost(" Claude.AI ")).toBe("claude.ai")
    expect(normalizeRedirectHost("::1")).toBe("[::1]")
    expect(normalizeRedirectHost("[::1]")).toBe("[::1]")
  })

  it.each([
    "*",
    "*.claude.ai",
    "",
    "claude.ai:443",
    "https://claude.ai",
    "a/b",
    "u@claude.ai",
    "127.1",
  ])("rejects %j", (entry) => {
    expect(() => normalizeRedirectHost(entry)).toThrow()
  })
})

describe("StaticTokenOAuthProvider state file", () => {
  let stateFile: string

  beforeEach(() => {
    stateFile = path.join(
      os.tmpdir(),
      `riffado-mcp-oauth-provider-test-${randomBytes(8).toString("hex")}.json`,
    )
  })

  afterEach(() => {
    fs.rmSync(stateFile, { force: true })
  })

  it("writes the state file at mode 0600", () => {
    const provider = new StaticTokenOAuthProvider({
      authToken: "secret",
      authorizeEndpoint: "http://localhost/authorize",
      stateFile,
    })
    provider.clientsStore.registerClient!(clientMetadata("c1"))

    const mode = fs.statSync(stateFile).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it("keeps the file at mode 0600 after a second write over an existing file", () => {
    // Naive in-place `writeFileSync(file, data)` only applies `mode` when
    // the file is created, so a pre-existing world-readable file would
    // silently stay that way on a later overwrite. Simulate that starting
    // condition explicitly.
    fs.writeFileSync(stateFile, "{}", { mode: 0o644 })
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o644)

    const provider = new StaticTokenOAuthProvider({
      authToken: "secret",
      authorizeEndpoint: "http://localhost/authorize",
      stateFile,
    })
    // First write (registration #1) via the provider.
    provider.clientsStore.registerClient!(clientMetadata("c1"))
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600)

    // Second write must not regress the mode either.
    provider.clientsStore.registerClient!(clientMetadata("c2"))
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600)
  })

  it("does not leave a stray temp file behind after persisting", () => {
    const provider = new StaticTokenOAuthProvider({
      authToken: "secret",
      authorizeEndpoint: "http://localhost/authorize",
      stateFile,
    })
    provider.clientsStore.registerClient!(clientMetadata("c1"))

    const dir = path.dirname(stateFile)
    const base = path.basename(stateFile)
    const leftovers = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`.${base}.`) && f.endsWith(".tmp"))
    expect(leftovers).toEqual([])
  })

  it("survives a restart and keeps the persisted client registered", () => {
    const provider1 = new StaticTokenOAuthProvider({
      authToken: "secret",
      authorizeEndpoint: "http://localhost/authorize",
      stateFile,
    })
    const client = provider1.clientsStore.registerClient!(
      clientMetadata("c1"),
    ) as OAuthClientInformationFull

    const provider2 = new StaticTokenOAuthProvider({
      authToken: "secret",
      authorizeEndpoint: "http://localhost/authorize",
      stateFile,
    })
    expect(provider2.clientsStore.getClient(client.client_id)).toBeDefined()
  })
})

describe("StaticTokenOAuthProvider token rotation revokes persisted state", () => {
  let stateFile: string

  beforeEach(() => {
    stateFile = path.join(
      os.tmpdir(),
      `riffado-mcp-oauth-rotation-test-${randomBytes(8).toString("hex")}.json`,
    )
  })

  afterEach(() => {
    fs.rmSync(stateFile, { force: true })
    vi.restoreAllMocks()
  })

  it("persists a fingerprint of the shared token, never the token itself", async () => {
    const authToken = "a-very-distinctive-shared-secret-value-0123456789"
    const provider = newProvider({ authToken, stateFile })
    provider.clientsStore.registerClient!(clientMetadata("c1"))

    const raw = fs.readFileSync(stateFile, "utf-8")
    expect(raw).not.toContain(authToken)
    const state = JSON.parse(raw)
    expect(state.authTokenFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it("keeps clients and tokens across a restart with the same token", async () => {
    const provider1 = newProvider({ stateFile })
    const { client, tokens } = await issueTokens(provider1)

    const provider2 = newProvider({ stateFile })
    expect(provider2.clientsStore.getClient(client.client_id)).toBeDefined()
    expect(provider2.getValidAccessToken(tokens.access_token)).toBeDefined()
    await expect(
      provider2.exchangeRefreshToken(client, tokens.refresh_token!),
    ).resolves.toHaveProperty("access_token")
  })

  it("discards all clients and tokens when the shared token was rotated", async () => {
    const provider1 = newProvider({ stateFile })
    const { client, tokens } = await issueTokens(provider1)

    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const provider2 = newProvider({ authToken: "rotated-secret", stateFile })

    expect(provider2.clientsStore.getClient(client.client_id)).toBeUndefined()
    expect(provider2.getValidAccessToken(tokens.access_token)).toBeUndefined()
    await expect(provider2.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow()
    expect(log).toHaveBeenCalledWith(expect.stringContaining("different HTTP_AUTH_TOKEN"))

    // The stale grants are wiped from disk too, not just ignored in memory,
    // and the file now carries the new token's fingerprint.
    const raw = fs.readFileSync(stateFile, "utf-8")
    expect(raw).not.toContain(tokens.access_token)
    expect(raw).not.toContain(tokens.refresh_token!)
    expect(raw).not.toContain(client.client_id)

    // Rotating back must not resurrect anything either.
    const provider3 = newProvider({ stateFile })
    expect(provider3.clientsStore.getClient(client.client_id)).toBeUndefined()
  })

  it("discards a state file with no fingerprint (pre-fingerprint format)", () => {
    const now = Math.floor(Date.now() / 1000)
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        clients: [
          ["legacy-client", { client_id: "legacy-client", redirect_uris: ["http://x/cb"] }],
        ],
        accessTokens: [
          [
            "legacy-at",
            { token: "legacy-at", clientId: "legacy-client", scopes: [], expiresAt: now + 3600 },
          ],
        ],
        refreshTokens: [
          ["legacy-rt", { clientId: "legacy-client", scopes: [], expiresAt: now + 3600 }],
        ],
      }),
    )
    vi.spyOn(console, "error").mockImplementation(() => {})
    const provider = newProvider({ stateFile })
    expect(provider.clientsStore.getClient("legacy-client")).toBeUndefined()
    expect(provider.getValidAccessToken("legacy-at")).toBeUndefined()
  })

  it("deletes a stale state file when it can't be rewritten", () => {
    const provider1 = newProvider({ stateFile })
    void provider1.clientsStore.registerClient!(clientMetadata("old"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("EROFS: read-only file system")
    })
    newProvider({ authToken: "rotated-secret", stateFile })
    write.mockRestore()
    expect(fs.existsSync(stateFile)).toBe(false)
  })

  it("refuses to start when a stale state file can be neither rewritten nor deleted", () => {
    const provider1 = newProvider({ stateFile })
    void provider1.clientsStore.registerClient!(clientMetadata("old"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("EROFS: read-only file system")
    })
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw new Error("EROFS: read-only file system")
    })
    expect(() => newProvider({ authToken: "rotated-secret", stateFile })).toThrow(
      /Refusing to start/,
    )
    write.mockRestore()
    unlink.mockRestore()
    expect(fs.existsSync(stateFile)).toBe(true)
  })
})

describe("StaticTokenOAuthProvider refresh token TTL", () => {
  let stateFile: string

  beforeEach(() => {
    stateFile = path.join(
      os.tmpdir(),
      `riffado-mcp-oauth-refresh-ttl-test-${randomBytes(8).toString("hex")}.json`,
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(stateFile, { force: true })
  })

  it("stores an expiresAt 90 days out by default", async () => {
    const provider = newProvider({ stateFile })
    const before = Math.floor(Date.now() / 1000)
    const { tokens } = await issueTokens(provider)
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
    const [, stored] = state.refreshTokens.find(
      ([t]: [string]) => t === sha256(tokens.refresh_token!),
    )
    expect(stored.expiresAt).toBeGreaterThanOrEqual(before + 90 * 24 * 60 * 60)
    expect(stored.expiresAt).toBeLessThanOrEqual(before + 90 * 24 * 60 * 60 + 5)
  })

  it("accepts a refresh token inside its TTL and rejects it once expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const provider = newProvider()
    const first = await issueTokens(provider)
    const second = await issueTokens(provider)

    vi.setSystemTime(Date.now() + 89 * DAY)
    await expect(
      provider.exchangeRefreshToken(first.client, first.tokens.refresh_token!),
    ).resolves.toHaveProperty("access_token")

    vi.setSystemTime(Date.now() + 2 * DAY)
    await expect(
      provider.exchangeRefreshToken(second.client, second.tokens.refresh_token!),
    ).rejects.toThrow(/expired/)
  })

  it("rejects a refresh token at the exact second it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(Math.floor(Date.now() / 1000) * 1000)
    const provider = newProvider({ refreshTokenTtlSeconds: 60 })
    const { client, tokens } = await issueTokens(provider)
    vi.setSystemTime(Date.now() + 60_000)
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow(
      /expired/,
    )
  })

  it("honours a custom refreshTokenTtlSeconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const provider = newProvider({ refreshTokenTtlSeconds: 60 })
    const { client, tokens } = await issueTokens(provider)
    vi.setSystemTime(Date.now() + 61_000)
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow(
      /expired/,
    )
  })

  it("drops expired refresh tokens when loading the state file", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const provider1 = newProvider({ stateFile, refreshTokenTtlSeconds: 60 })
    const { client, tokens } = await issueTokens(provider1)

    vi.setSystemTime(Date.now() + 120_000)
    const provider2 = newProvider({ stateFile })
    await expect(provider2.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow(
      /Invalid refresh token/,
    )
  })

  it("prunes expired access and refresh tokens from the file on the next write", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const provider = newProvider({
      stateFile,
      accessTokenTtlSeconds: 60,
      refreshTokenTtlSeconds: 60,
    })
    const { tokens } = await issueTokens(provider)
    expect(fs.readFileSync(stateFile, "utf-8")).toContain(sha256(tokens.access_token))

    vi.setSystemTime(Date.now() + 120_000)
    provider.clientsStore.registerClient!(clientMetadata("trigger-a-write"))

    const raw = fs.readFileSync(stateFile, "utf-8")
    expect(raw).not.toContain(sha256(tokens.access_token))
    expect(raw).not.toContain(sha256(tokens.refresh_token!))
  })
})

describe("StaticTokenOAuthProvider authorize() token source", () => {
  const params = {
    redirectUri: "http://localhost/callback",
    codeChallenge: "challenge",
    scopes: [],
  }

  it("ignores a correct token passed in the query string and shows the login page", async () => {
    const provider = newProvider()
    const client = provider.clientsStore.registerClient!(
      clientMetadata("c"),
    ) as OAuthClientInformationFull
    const { res, out } = fakeResponse({ method: "GET", query: { mcp_auth_token: TOKEN } })
    await provider.authorize(client, params, res)
    expect(out.location).toBeUndefined()
    expect(out.statusCode).toBe(200)
    expect(out.body).toContain('name="mcp_auth_token"')
  })

  it("ignores a token in the body of a non-POST request", async () => {
    const provider = newProvider()
    const client = provider.clientsStore.registerClient!(
      clientMetadata("c"),
    ) as OAuthClientInformationFull
    const { res, out } = fakeResponse({ method: "GET", body: { mcp_auth_token: TOKEN } })
    await provider.authorize(client, params, res)
    expect(out.location).toBeUndefined()
  })

  it("accepts the token from a POST body", async () => {
    const provider = newProvider()
    const client = provider.clientsStore.registerClient!(
      clientMetadata("c"),
    ) as OAuthClientInformationFull
    const { res, out } = fakeResponse({ method: "POST", body: { mcp_auth_token: TOKEN } })
    await provider.authorize(client, params, res)
    expect(out.statusCode).toBe(302)
    expect(new URL(out.location!).searchParams.get("code")).toBeTruthy()
  })
})

describe("StaticTokenOAuthProvider login page", () => {
  async function renderFor(redirectUri: string, method = "GET", body?: Record<string, unknown>) {
    const provider = newProvider({ authorizeEndpoint: "https://mcp.example.com/authorize" })
    const client = provider.clientsStore.registerClient!(
      clientMetadata("c"),
    ) as OAuthClientInformationFull
    const { res, out } = fakeResponse({ method, body })
    await provider.authorize(client, { redirectUri, codeChallenge: "x", scopes: [] }, res)
    return out
  }

  it("shows the redirect target host so the user sees where the code goes", async () => {
    const out = await renderFor("https://claude.ai/api/mcp/auth_callback")
    expect(out.body).toContain("will be redirected to <strong>claude.ai</strong>")
  })

  it("escapes the redirect host", async () => {
    const out = await renderFor("http://a'b/cb")
    expect(out.body).toContain("<strong>a&#39;b</strong>")
    expect(out.body).not.toContain("a'b")
  })

  it("shows the scheme for custom-scheme redirect URIs", async () => {
    const out = await renderFor("cursor://anysphere.cursor-retrieval/oauth/callback")
    expect(out.body).toContain("<strong>cursor://anysphere.cursor-retrieval</strong>")
  })

  it("sets security headers, with the redirect origin allowed in form-action", async () => {
    const out = await renderFor("https://claude.ai/api/mcp/auth_callback")
    const csp = out.headers["content-security-policy"]
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("style-src 'unsafe-inline'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toMatch(/form-action 'self' https:\/\/mcp\.example\.com https:\/\/claude\.ai(;|$)/)
    expect(out.headers["x-frame-options"]).toBe("DENY")
    expect(out.headers["referrer-policy"]).toBe("no-referrer")
    expect(out.headers["cache-control"]).toBe("no-store")
    expect(out.headers["x-content-type-options"]).toBe("nosniff")
  })

  it("sets the same headers on the wrong-token page and the success redirect", async () => {
    const wrong = await renderFor("https://claude.ai/cb", "POST", { mcp_auth_token: "nope" })
    expect(wrong.statusCode).toBe(401)
    expect(wrong.headers["x-frame-options"]).toBe("DENY")
    const ok = await renderFor("https://claude.ai/cb", "POST", { mcp_auth_token: TOKEN })
    expect(ok.statusCode).toBe(302)
    expect(ok.headers["cache-control"]).toBe("no-store")
    expect(ok.headers["content-security-policy"]).toContain("https://claude.ai")
  })
})

describe("cspSourceFor", () => {
  it("returns the origin for plain http(s) URLs", () => {
    expect(cspSourceFor("https://claude.ai/api/cb")).toBe("https://claude.ai")
    expect(cspSourceFor("http://localhost:6274/cb")).toBe("http://localhost:6274")
  })

  it("falls back to a scheme source for custom schemes", () => {
    expect(cspSourceFor("cursor://anysphere.cursor-retrieval/cb")).toBe("cursor:")
    expect(cspSourceFor("com.example.app:/cb")).toBe("com.example.app:")
  })

  it("never lets CSP metacharacters from a hostname into the header", () => {
    expect(cspSourceFor("http://a;script-src*/cb")).toBe("http:")
    expect(cspSourceFor("http://a,b/cb")).toBe("http:")
    expect(cspSourceFor("http://a'b/cb")).toBe("http:")
  })

  it("returns undefined for unparseable input", () => {
    expect(cspSourceFor("not a url")).toBeUndefined()
  })
})

describe("StaticTokenOAuthProvider token storage and lifetimes", () => {
  let stateFile: string

  beforeEach(() => {
    stateFile = path.join(
      os.tmpdir(),
      `riffado-mcp-oauth-token-storage-test-${randomBytes(8).toString("hex")}.json`,
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    fs.rmSync(stateFile, { force: true })
  })

  it("persists tokens only as SHA-256 hashes, in a versioned format", async () => {
    const provider = newProvider({ stateFile })
    const { tokens } = await issueTokens(provider)
    const raw = fs.readFileSync(stateFile, "utf-8")
    expect(raw).not.toContain(tokens.access_token)
    expect(raw).not.toContain(tokens.refresh_token!)
    const state = JSON.parse(raw)
    expect(state.version).toBe(2)
    expect(state.accessTokens.map(([k]: [string]) => k)).toEqual([sha256(tokens.access_token)])
    expect(state.refreshTokens.map(([k]: [string]) => k)).toEqual([sha256(tokens.refresh_token!)])
  })

  it("returns the presented token in AuthInfo, also after a restart", async () => {
    const { tokens } = await issueTokens(newProvider({ stateFile }))
    const provider2 = newProvider({ stateFile })
    const info = await provider2.verifyAccessToken(tokens.access_token)
    expect(info.token).toBe(tokens.access_token)
    expect(info.resource).toBeUndefined()
    // Looking up by the hash itself must not work: the hash is not a token.
    expect(provider2.getValidAccessToken(sha256(tokens.access_token))).toBeUndefined()
  })

  it("discards an unversioned (v1) state file even with a matching fingerprint", async () => {
    const provider1 = newProvider({ stateFile })
    const { client, tokens } = await issueTokens(provider1)
    const v2 = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
    const now = Math.floor(Date.now() / 1000)
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        authTokenFingerprint: v2.authTokenFingerprint,
        clients: v2.clients,
        accessTokens: [
          [
            tokens.access_token,
            {
              token: tokens.access_token,
              clientId: client.client_id,
              scopes: [],
              expiresAt: now + 60,
            },
          ],
        ],
        refreshTokens: [],
      }),
    )
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const provider2 = newProvider({ stateFile })
    expect(provider2.clientsStore.getClient(client.client_id)).toBeUndefined()
    expect(provider2.getValidAccessToken(tokens.access_token)).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining("log in again once"))
    expect(JSON.parse(fs.readFileSync(stateFile, "utf-8"))).toMatchObject({
      version: 2,
      clients: [],
    })
  })

  it("issues access tokens valid for 1 hour by default", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const provider = newProvider()
    const { tokens } = await issueTokens(provider)
    expect(tokens.expires_in).toBe(3600)
    vi.setSystemTime(Date.now() + 3599_000)
    expect(provider.getValidAccessToken(tokens.access_token)).toBeDefined()
    vi.setSystemTime(Date.now() + 2_000)
    expect(provider.getValidAccessToken(tokens.access_token)).toBeUndefined()
  })

  it("revokes the previous access token when its refresh token is used", async () => {
    const provider = newProvider()
    const { client, tokens } = await issueTokens(provider)
    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!)
    expect(provider.getValidAccessToken(tokens.access_token)).toBeUndefined()
    expect(provider.getValidAccessToken(refreshed.access_token)).toBeDefined()
    // And the chain continues: the next refresh revokes the second one.
    await provider.exchangeRefreshToken(client, refreshed.refresh_token!)
    expect(provider.getValidAccessToken(refreshed.access_token)).toBeUndefined()
  })

  it("keeps the access-token pairing across a restart", async () => {
    const { client, tokens } = await issueTokens(newProvider({ stateFile }))
    const provider2 = newProvider({ stateFile })
    await provider2.exchangeRefreshToken(client, tokens.refresh_token!)
    expect(provider2.getValidAccessToken(tokens.access_token)).toBeUndefined()
  })

  it("refuses to widen scopes on refresh, leaving the refresh token usable", async () => {
    const provider = newProvider()
    const { client, tokens } = await issueTokens(provider, ["read"])
    await expect(
      provider.exchangeRefreshToken(client, tokens.refresh_token!, ["read", "write"]),
    ).rejects.toBeInstanceOf(InvalidScopeError)

    const narrowed = await provider.exchangeRefreshToken(client, tokens.refresh_token!, ["read"])
    expect(narrowed.scope).toBe("read")
    expect(provider.getValidAccessToken(narrowed.access_token)?.scopes).toEqual(["read"])
  })

  it("keeps the original scopes when a refresh requests none", async () => {
    const provider = newProvider()
    const { client, tokens } = await issueTokens(provider, ["read", "write"])
    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!, [""])
    expect(refreshed.scope).toBe("read write")
  })

  it("rejects any scope on refresh of a grant that had none", async () => {
    const provider = newProvider()
    const { client, tokens } = await issueTokens(provider)
    await expect(
      provider.exchangeRefreshToken(client, tokens.refresh_token!, ["admin"]),
    ).rejects.toBeInstanceOf(InvalidScopeError)
  })

  it("prunes expired authorization codes when issuing a new one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const provider = newProvider()
    const client = provider.clientsStore.registerClient!(
      clientMetadata("c"),
    ) as OAuthClientInformationFull
    const authorize = () =>
      provider.authorize(
        client,
        { redirectUri: "http://localhost/callback", codeChallenge: "c", scopes: [] },
        fakeResponse({ method: "POST", body: { mcp_auth_token: TOKEN } }).res,
      )
    await authorize()
    await authorize()
    // @ts-expect-error private property access for test
    const codes = provider.authorizationCodes as Map<string, unknown>
    expect(codes.size).toBe(2)
    vi.setSystemTime(Date.now() + 10 * 60 * 1000)
    await authorize()
    expect(codes.size).toBe(1)
  })

  it("drops persisted clients (and their tokens) whose redirect host is no longer allowed", async () => {
    const { client, tokens } = await issueTokens(newProvider({ stateFile }))
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const provider2 = newProvider({ stateFile, allowedRedirectHosts: ["claude.ai"] })
    expect(provider2.clientsStore.getClient(client.client_id)).toBeUndefined()
    expect(provider2.getValidAccessToken(tokens.access_token)).toBeUndefined()
    await expect(provider2.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow()
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no longer allowed"))
    expect(fs.readFileSync(stateFile, "utf-8")).not.toContain(client.client_id)
  })

  it("revokes a refresh token together with its access token, only for the owning client", async () => {
    const provider = newProvider()
    const { client, tokens } = await issueTokens(provider)
    const other = provider.clientsStore.registerClient!(
      clientMetadata("other"),
    ) as OAuthClientInformationFull

    await provider.revokeToken(other, { token: tokens.refresh_token! })
    expect(provider.getValidAccessToken(tokens.access_token)).toBeDefined()

    await provider.revokeToken(client, { token: tokens.refresh_token! })
    expect(provider.getValidAccessToken(tokens.access_token)).toBeUndefined()
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow(
      /Invalid refresh token/,
    )
  })
})
