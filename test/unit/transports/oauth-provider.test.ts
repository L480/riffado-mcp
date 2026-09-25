import fs from "fs"
import os from "os"
import path from "path"
import { randomBytes } from "crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Response } from "express"
import { StaticTokenOAuthProvider } from "../../../src/transports/oauth-provider.js"
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js"

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
async function issueTokens(provider: StaticTokenOAuthProvider) {
  const client = provider.clientsStore.registerClient!(
    clientMetadata("c"),
  ) as OAuthClientInformationFull
  const { res, out } = fakeResponse({ method: "POST", body: { mcp_auth_token: TOKEN } })
  await provider.authorize(
    client,
    { redirectUri: "http://localhost/callback", codeChallenge: "challenge", scopes: [] },
    res,
  )
  const code = new URL(out.location!).searchParams.get("code")!
  const tokens = await provider.exchangeAuthorizationCode(client, code)
  return { client, tokens }
}

describe("StaticTokenOAuthProvider client registry cap", () => {
  it("evicts only the oldest client once at maxClients, keeping the rest", () => {
    const provider = new StaticTokenOAuthProvider({
      authToken: "secret",
      authorizeEndpoint: "http://localhost/authorize",
      maxClients: 3,
    })
    const register = provider.clientsStore.registerClient!

    const c1 = register(clientMetadata("c1")) as OAuthClientInformationFull
    const c2 = register(clientMetadata("c2")) as OAuthClientInformationFull
    const c3 = register(clientMetadata("c3")) as OAuthClientInformationFull
    expect(provider.clientsStore.getClient(c1.client_id)).toBeDefined()
    expect(provider.clientsStore.getClient(c2.client_id)).toBeDefined()
    expect(provider.clientsStore.getClient(c3.client_id)).toBeDefined()

    // Registering a 4th client over the cap of 3 must evict exactly the
    // oldest (c1), never the newer ones.
    const c4 = register(clientMetadata("c4")) as OAuthClientInformationFull

    expect(provider.clientsStore.getClient(c1.client_id)).toBeUndefined()
    expect(provider.clientsStore.getClient(c2.client_id)).toBeDefined()
    expect(provider.clientsStore.getClient(c3.client_id)).toBeDefined()
    expect(provider.clientsStore.getClient(c4.client_id)).toBeDefined()
  })

  it("defaults maxClients to 100", () => {
    const provider = new StaticTokenOAuthProvider({
      authToken: "secret",
      authorizeEndpoint: "http://localhost/authorize",
    })
    const register = provider.clientsStore.registerClient!
    const clients: OAuthClientInformationFull[] = []
    for (let i = 0; i < 100; i++) {
      clients.push(register(clientMetadata(`c${i}`)) as OAuthClientInformationFull)
    }
    // Still at the cap: the first-registered client must still be present.
    expect(provider.clientsStore.getClient(clients[0].client_id)).toBeDefined()

    // The 101st registration pushes it over, evicting the oldest.
    register(clientMetadata("c100"))
    expect(provider.clientsStore.getClient(clients[0].client_id)).toBeUndefined()
    expect(provider.clientsStore.getClient(clients[1].client_id)).toBeDefined()
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
    const [, stored] = state.refreshTokens.find(([t]: [string]) => t === tokens.refresh_token)
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
    expect(fs.readFileSync(stateFile, "utf-8")).toContain(tokens.access_token)

    vi.setSystemTime(Date.now() + 120_000)
    provider.clientsStore.registerClient!(clientMetadata("trigger-a-write"))

    const raw = fs.readFileSync(stateFile, "utf-8")
    expect(raw).not.toContain(tokens.access_token)
    expect(raw).not.toContain(tokens.refresh_token!)
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
