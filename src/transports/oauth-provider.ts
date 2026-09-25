/**
 * Ported from the author's own L480/mcp-picnic fork
 * (src/transports/oauth-provider.ts), where this static-token-wrapped-in-
 * OAuth-2.1 approach was written to get Claude's custom connectors to
 * authenticate against a shared secret. Same shape, renamed for Riffado.
 */
import { Response } from "express"
import { createHmac, randomUUID, randomBytes, timingSafeEqual } from "crypto"
import fs from "fs"
import path from "path"
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js"
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js"
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js"
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import {
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js"

/** Configuration for the static-token OAuth provider. */
export interface StaticTokenOAuthOptions {
  /** The shared secret token that gates access to the MCP server. */
  authToken: string
  /** Absolute URL of the authorization endpoint, used as the login form target. */
  authorizeEndpoint: string
  /** RFC 8707 resource identifier advertised for issued tokens. */
  resource?: string
  /** Lifetime of issued access tokens in seconds (default: 30 days). */
  accessTokenTtlSeconds?: number
  /**
   * Lifetime of issued refresh tokens in seconds (default: 90 days). Each
   * refresh rotates the token and starts a fresh lifetime, so this bounds
   * how long an *idle* connector stays logged in, not an active one.
   */
  refreshTokenTtlSeconds?: number
  /** Lifetime of an authorization code in seconds (default: 5 minutes). */
  authorizationCodeTtlSeconds?: number
  /** Human readable name displayed on the login page. */
  serverName?: string
  /**
   * Path to a file where registered clients and issued tokens are
   * persisted, so Claude's connector stays authenticated across container
   * recreation. Authorization codes are deliberately NOT persisted: they
   * are single-use and short-lived, so an in-flight login started right
   * before a restart simply has to be retried.
   */
  stateFile?: string
  /**
   * Maximum number of registered clients kept at once (default: 100).
   * `/register` is unauthenticated per the MCP DCR spec, so without a cap
   * an anonymous caller could grow the in-memory map — and the on-disk
   * state file `persistState` rewrites on every registration — without
   * bound. Once at capacity, the oldest client is evicted to make room.
   */
  maxClients?: number
}

interface PersistedState {
  /**
   * HMAC of the shared token the state was issued under (never the token
   * itself). On load, a missing or different value means `HTTP_AUTH_TOKEN`
   * was rotated since, and everything in the file is discarded — rotating
   * the secret must also revoke every OAuth grant obtained with the old one.
   */
  authTokenFingerprint?: string
  clients: [string, OAuthClientInformationFull][]
  accessTokens: [string, AuthInfo][]
  refreshTokens: [string, StoredRefreshToken][]
}

interface StoredAuthorizationCode {
  clientId: string
  codeChallenge: string
  redirectUri: string
  scopes: string[]
  resource?: string
  expiresAt: number
}

interface StoredRefreshToken {
  clientId: string
  scopes: string[]
  resource?: string
  /** Expiry as epoch seconds, same unit as `AuthInfo.expiresAt`. */
  expiresAt: number
}

/** Thrown when a state file from a previous auth token can't be removed. */
class StaleStateFileError extends Error {}

/** Fixed HMAC message: the fingerprint is keyed by the token, so it can't be
 * compared against a plain SHA-256 of the token computed anywhere else. */
const FINGERPRINT_CONTEXT = "riffado-mcp:oauth-state:auth-token-fingerprint:v1"

/** Fingerprint of the shared token for the state file. */
function fingerprintAuthToken(authToken: string): string {
  return createHmac("sha256", authToken).update(FINGERPRINT_CONTEXT).digest("hex")
}

/** Escapes a string for safe inclusion inside an HTML attribute or text node. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * A CSP source expression for the origin of `url`, or `undefined` if it
 * can't be expressed safely. WHATWG URL parsing lets characters such as
 * `;`, `,` and `'` through in hostnames, and those would break out of the
 * directive (header injection into our own CSP), so anything beyond a plain
 * `scheme://host[:port]` falls back to a bare scheme source (`https:`),
 * and custom-scheme redirect URIs (opaque origin, e.g. `cursor://…`) use
 * the scheme source too.
 */
export function cspSourceFor(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const schemeSource = /^[a-z][a-z0-9+.-]*:$/i.test(parsed.protocol) ? parsed.protocol : undefined
  if (parsed.origin !== "null" && /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.\-[\]:]+$/i.test(parsed.origin)) {
    return parsed.origin
  }
  return schemeSource
}

/** Where a redirect URI sends the user, for display on the login page. */
function redirectTargetLabel(redirectUri: string): string {
  try {
    const parsed = new URL(redirectUri)
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.host
    }
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.protocol
  } catch {
    return redirectUri
  }
}

/** Base64url-encodes a buffer without padding, suitable for opaque tokens. */
function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * An OAuth 2.1 server provider that wraps a single static shared token.
 *
 * Claude's custom connector UI only speaks OAuth 2.0 (dynamic client
 * registration + authorization code + PKCE); it offers no field for pasting
 * a static bearer token. This provider implements just enough of the OAuth
 * flow for that UI to succeed: the user proves knowledge of the shared
 * `HTTP_AUTH_TOKEN` on a small login page during the authorization step,
 * and in return receives a normal OAuth access token sent as
 * `Authorization: Bearer <token>` on every subsequent MCP request.
 */
export class StaticTokenOAuthProvider implements OAuthServerProvider {
  private readonly authTokenBuffer: Buffer
  private readonly authTokenFingerprint: string
  private readonly authorizeEndpoint: string
  private readonly resource?: string
  private readonly accessTokenTtlSeconds: number
  private readonly refreshTokenTtlSeconds: number
  private readonly authorizationCodeTtlSeconds: number
  private readonly serverName: string
  private readonly stateFile?: string
  private readonly maxClients: number

  private readonly clients = new Map<string, OAuthClientInformationFull>()
  private readonly authorizationCodes = new Map<string, StoredAuthorizationCode>()
  private readonly accessTokens = new Map<string, AuthInfo>()
  private readonly refreshTokens = new Map<string, StoredRefreshToken>()

  constructor(options: StaticTokenOAuthOptions) {
    this.authTokenBuffer = Buffer.from(options.authToken)
    this.authTokenFingerprint = fingerprintAuthToken(options.authToken)
    this.authorizeEndpoint = options.authorizeEndpoint
    this.resource = options.resource
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 30 * 24 * 60 * 60
    this.refreshTokenTtlSeconds = options.refreshTokenTtlSeconds ?? 90 * 24 * 60 * 60
    this.authorizationCodeTtlSeconds = options.authorizationCodeTtlSeconds ?? 5 * 60
    this.serverName = options.serverName ?? "Riffado MCP"
    this.stateFile = options.stateFile
    this.maxClients = options.maxClients ?? 100
    this.loadState()
  }

  public readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId: string) => this.clients.get(clientId),
    registerClient: (client) => {
      if (this.clients.size >= this.maxClients) {
        this.evictOldestClient()
      }
      const clientId = randomUUID()
      const full: OAuthClientInformationFull = {
        ...client,
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
      }
      this.clients.set(clientId, full)
      this.persistState()
      return full
    },
  }

  /**
   * Evicts the single oldest registered client to make room under
   * `maxClients`. Picked by `client_id_issued_at` rather than relying on
   * `Map` insertion order — the two agree in practice (insertion order is
   * issuance order here, including after a state-file reload, since that
   * reload replays the persisted array in order), but issued_at is the
   * actual source of truth and the lookup is O(maxClients), cheap at this
   * cap size.
   *
   * Deliberately does NOT touch `accessTokens`/`refreshTokens` belonging to
   * the evicted client: `verifyAccessToken`/`getValidAccessToken` never
   * check that a token's client still exists, only that the token itself
   * is known and unexpired, and `revokeToken` already deletes tokens
   * independently of the client registry. So an evicted client's
   * previously issued tokens simply keep working until their own TTL
   * expires — consistent with how tokens already behave everywhere else in
   * this provider, and correct because eviction here is a registry-size
   * safeguard against unbounded `/register` growth, not a revocation
   * mechanism.
   */
  private evictOldestClient(): void {
    let oldestId: string | undefined
    let oldestIssuedAt = Infinity
    for (const [id, client] of this.clients) {
      const issuedAt = client.client_id_issued_at ?? 0
      if (issuedAt < oldestIssuedAt) {
        oldestIssuedAt = issuedAt
        oldestId = id
      }
    }
    if (oldestId !== undefined) {
      this.clients.delete(oldestId)
    }
  }

  /**
   * Loads previously persisted clients and tokens from `stateFile`, if
   * configured. Reads synchronously so state is available before the
   * server starts accepting requests. Missing or corrupt files are treated
   * as "no prior state" rather than a fatal error.
   *
   * State issued under a different shared token (fingerprint mismatch, or
   * no fingerprint at all) is discarded wholesale and the file rewritten
   * empty, so rotating `HTTP_AUTH_TOKEN` revokes every client and token
   * obtained with the old one. Expired access and refresh tokens are
   * dropped too.
   */
  private loadState(): void {
    if (!this.stateFile) {
      return
    }

    let raw: string
    try {
      raw = fs.readFileSync(this.stateFile, "utf-8")
    } catch {
      return
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      const now = Math.floor(Date.now() / 1000)

      if (!this.fingerprintMatches(parsed.authTokenFingerprint)) {
        console.error(
          `Discarding OAuth state from ${this.stateFile}: it was issued under a different ` +
            `HTTP_AUTH_TOKEN (or predates token fingerprinting). All previously registered ` +
            `clients and issued tokens are revoked; connectors must log in again.`,
        )
        this.discardStaleStateFile()
        return
      }

      for (const [clientId, client] of parsed.clients ?? []) {
        this.clients.set(clientId, client)
      }
      for (const [token, authInfo] of parsed.accessTokens ?? []) {
        if (authInfo.expiresAt !== undefined && authInfo.expiresAt < now) {
          continue
        }
        this.accessTokens.set(token, {
          ...authInfo,
          resource: authInfo.resource ? new URL(authInfo.resource as unknown as string) : undefined,
        })
      }
      for (const [token, refreshToken] of parsed.refreshTokens ?? []) {
        // A missing expiresAt can only come from a hand-edited or foreign
        // file; treat it as expired rather than as "never expires".
        if (typeof refreshToken.expiresAt !== "number" || refreshToken.expiresAt < now) {
          continue
        }
        this.refreshTokens.set(token, refreshToken)
      }
      console.error(
        `Restored OAuth state from ${this.stateFile} (${this.clients.size} client(s), ` +
          `${this.accessTokens.size} access token(s), ${this.refreshTokens.size} refresh token(s)).`,
      )
    } catch (error) {
      if (error instanceof StaleStateFileError) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Ignoring unreadable OAuth state file ${this.stateFile}: ${message}`)
    }
  }

  /**
   * Replaces a state file issued under a different shared token with an
   * empty one. Unlike every other persist, this one must not be
   * best-effort: if the stale file survived, the next restart with the old
   * token would match its fingerprint again and resurrect every revoked
   * client and token. So fall back to deleting it, and if even that fails,
   * refuse to start.
   */
  private discardStaleStateFile(): void {
    if (this.persistState()) {
      return
    }
    try {
      fs.unlinkSync(this.stateFile!)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new StaleStateFileError(
        `Could not replace or delete stale OAuth state file ${this.stateFile} (${message}). ` +
          `Refusing to start: it holds tokens issued under a previous HTTP_AUTH_TOKEN. ` +
          `Delete it manually or make its directory writable.`,
      )
    }
  }

  /**
   * Persists clients and tokens to `stateFile`, if configured. Best-effort:
   * a write failure is logged and reported via the return value, never thrown, since
   * losing persistence should not break the OAuth flow that just
   * succeeded in memory.
   *
   * The file holds plaintext 30-day bearer / 90-day refresh tokens, so it must land
   * at 0600, and a crash mid-write must not corrupt existing state. Both
   * come from writing a uniquely-named temp file (mode set at creation —
   * `writeFileSync`'s `mode` option is only applied when the file doesn't
   * already exist yet, so writing in place over the target, or over a
   * reused temp filename, would silently keep whatever permissions were
   * already there) and `renameSync`-ing it over the target, which is
   * atomic on the same filesystem.
   */
  private persistState(): boolean {
    if (!this.stateFile) {
      return true
    }

    this.pruneExpiredTokens()

    const state: PersistedState = {
      authTokenFingerprint: this.authTokenFingerprint,
      clients: Array.from(this.clients.entries()),
      accessTokens: Array.from(this.accessTokens.entries()),
      refreshTokens: Array.from(this.refreshTokens.entries()),
    }

    const tmpFile = path.join(
      path.dirname(this.stateFile),
      `.${path.basename(this.stateFile)}.${randomUUID()}.tmp`,
    )

    try {
      fs.writeFileSync(tmpFile, JSON.stringify(state), { mode: 0o600 })
      fs.renameSync(tmpFile, this.stateFile)
      return true
    } catch (error) {
      try {
        fs.unlinkSync(tmpFile)
      } catch {
        // best-effort cleanup of the temp file; the error below is what matters
      }
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Failed to persist OAuth state to ${this.stateFile}: ${message}`)
      return false
    }
  }

  /** Whether a persisted fingerprint matches the current shared token. */
  private fingerprintMatches(persisted: unknown): boolean {
    if (typeof persisted !== "string") {
      return false
    }
    const provided = Buffer.from(persisted)
    const expected = Buffer.from(this.authTokenFingerprint)
    return provided.length === expected.length && timingSafeEqual(provided, expected)
  }

  /** Drops expired access and refresh tokens from memory (and so from the
   * next state-file write). */
  private pruneExpiredTokens(): void {
    const now = Math.floor(Date.now() / 1000)
    for (const [token, authInfo] of this.accessTokens) {
      if (authInfo.expiresAt !== undefined && authInfo.expiresAt < now) {
        this.accessTokens.delete(token)
      }
    }
    for (const [token, refreshToken] of this.refreshTokens) {
      if (refreshToken.expiresAt < now) {
        this.refreshTokens.delete(token)
      }
    }
  }

  /** Constant-time comparison of a candidate token against the shared secret. */
  private isValidStaticToken(token: string | undefined): boolean {
    if (typeof token !== "string") {
      return false
    }
    const provided = Buffer.from(token)
    if (provided.length !== this.authTokenBuffer.length) {
      return false
    }
    return timingSafeEqual(provided, this.authTokenBuffer)
  }

  /**
   * Renders the login page shown during the authorization step. All OAuth
   * parameters are carried through as hidden fields so the POST re-enters
   * the standard authorization handler with the submitted token attached.
   */
  private renderLoginPage(
    params: AuthorizationParams,
    client: OAuthClientInformationFull,
    error?: string,
  ): string {
    const hidden = (name: string, value: string | undefined) =>
      value === undefined
        ? ""
        : `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`

    const clientLabel = client.client_name ? escapeHtml(client.client_name) : "an MCP client"
    const errorBlock = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect to ${escapeHtml(this.serverName)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0;
    min-height: 100vh; display: grid; place-items: center; background: #f5f5f7; color: #1d1d1f; }
  @media (prefers-color-scheme: dark) { body { background: #1c1c1e; color: #f5f5f7; } .card { background: #2c2c2e !important; } input { background: #1c1c1e !important; color: #f5f5f7 !important; border-color: #48484a !important; } }
  .card { background: #fff; padding: 2rem; border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.12);
    width: min(92vw, 380px); box-sizing: border-box; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p { margin: 0 0 1rem; color: #6e6e73; font-size: .9rem; line-height: 1.4; }
  label { display: block; font-size: .85rem; font-weight: 600; margin-bottom: .4rem; }
  input[type=password] { width: 100%; padding: .7rem .8rem; font-size: 1rem; border: 1px solid #d2d2d7;
    border-radius: 9px; box-sizing: border-box; }
  button { margin-top: 1.1rem; width: 100%; padding: .75rem; font-size: 1rem; font-weight: 600;
    color: #fff; background: #0071e3; border: 0; border-radius: 9px; cursor: pointer; }
  button:hover { background: #0077ed; }
  .error { color: #d70015; font-weight: 600; }
</style>
</head>
<body>
  <form class="card" method="post" action="${escapeHtml(this.authorizeEndpoint)}">
    <h1>Connect to ${escapeHtml(this.serverName)}</h1>
    <p>${clientLabel} wants to connect and will be redirected to <strong>${escapeHtml(redirectTargetLabel(params.redirectUri))}</strong>. Only continue if you expect that. Enter the access token to authorize.</p>
    ${errorBlock}
    <label for="mcp_auth_token">Access token</label>
    <input id="mcp_auth_token" name="mcp_auth_token" type="password" autocomplete="off" autofocus required />
    ${hidden("response_type", "code")}
    ${hidden("client_id", client.client_id)}
    ${hidden("redirect_uri", params.redirectUri)}
    ${hidden("code_challenge", params.codeChallenge)}
    ${hidden("code_challenge_method", "S256")}
    ${hidden("scope", params.scopes && params.scopes.length > 0 ? params.scopes.join(" ") : undefined)}
    ${hidden("state", params.state)}
    ${hidden("resource", params.resource ? params.resource.href : undefined)}
    <button type="submit">Connect</button>
  </form>
</body>
</html>`
  }

  /**
   * Hardening headers for every response `authorize()` produces. The login
   * page needs only its inline `<style>` and a form post; `form-action`
   * covers the authorize endpoint the form posts to *and* the client's
   * redirect origin, because some browsers apply `form-action` to the 302
   * that follows a successful login too.
   */
  private setAuthorizeSecurityHeaders(res: Response, redirectUri: string): void {
    const formAction = new Set(["'self'"])
    for (const source of [cspSourceFor(this.authorizeEndpoint), cspSourceFor(redirectUri)]) {
      if (source) formAction.add(source)
    }
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        `form-action ${[...formAction].join(" ")}`,
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join("; "),
    )
    res.setHeader("X-Frame-Options", "DENY")
    res.setHeader("Referrer-Policy", "no-referrer")
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("X-Content-Type-Options", "nosniff")
  }

  /**
   * Handles the authorization endpoint. On the initial GET a login page is
   * rendered; once the correct token is submitted an authorization code is
   * issued and the user agent is redirected back to the client.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // The shared secret is only ever read from a POST body. A query-string
    // copy (`GET /authorize?...&mcp_auth_token=...`) would land in browser
    // history, proxy/access logs and Referer headers, so it's ignored and
    // the login page is shown instead.
    const req = res.req as { method?: string; body?: Record<string, unknown> } | undefined
    const submitted = req?.method === "POST" ? req.body?.mcp_auth_token : undefined

    this.setAuthorizeSecurityHeaders(res, params.redirectUri)

    if (typeof submitted !== "string" || submitted.length === 0) {
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8")
      res.send(this.renderLoginPage(params, client))
      return
    }

    if (!this.isValidStaticToken(submitted)) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8")
      res.send(this.renderLoginPage(params, client, "Invalid access token. Please try again."))
      return
    }

    const code = base64url(randomBytes(32))
    this.authorizationCodes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      expiresAt: Date.now() + this.authorizationCodeTtlSeconds * 1000,
    })

    const redirectUrl = new URL(params.redirectUri)
    redirectUrl.searchParams.set("code", code)
    if (params.state !== undefined) {
      redirectUrl.searchParams.set("state", params.state)
    }
    res.redirect(302, redirectUrl.href)
  }

  /**
   * Returns the PKCE challenge stored for an authorization code so the SDK
   * can validate the code verifier during token exchange.
   */
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const stored = this.authorizationCodes.get(authorizationCode)
    if (!stored || stored.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code")
    }
    return stored.codeChallenge
  }

  /** Exchanges a validated authorization code for a fresh access/refresh token pair. */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const stored = this.authorizationCodes.get(authorizationCode)
    if (!stored || stored.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code")
    }
    this.authorizationCodes.delete(authorizationCode)

    if (stored.expiresAt < Date.now()) {
      throw new InvalidGrantError("Authorization code has expired")
    }
    if (redirectUri !== undefined && redirectUri !== stored.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request")
    }

    return this.issueTokens(client.client_id, stored.scopes, stored.resource)
  }

  /** Exchanges a refresh token for a new access/refresh token pair. */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const stored = this.refreshTokens.get(refreshToken)
    if (!stored || stored.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token")
    }
    this.refreshTokens.delete(refreshToken)

    if (stored.expiresAt < Math.floor(Date.now() / 1000)) {
      this.persistState()
      throw new InvalidGrantError("Refresh token has expired")
    }

    const grantedScopes = scopes && scopes.length > 0 ? scopes : stored.scopes
    return this.issueTokens(client.client_id, grantedScopes, stored.resource)
  }

  /** Issues a new access token (and rotating refresh token) for a client. */
  private issueTokens(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const accessToken = base64url(randomBytes(32))
    const refreshToken = base64url(randomBytes(32))
    const now = Math.floor(Date.now() / 1000)
    const expiresAt = now + this.accessTokenTtlSeconds

    this.accessTokens.set(accessToken, {
      token: accessToken,
      clientId,
      scopes,
      expiresAt,
      resource: resource ? new URL(resource) : this.resource ? new URL(this.resource) : undefined,
    })
    this.refreshTokens.set(refreshToken, {
      clientId,
      scopes,
      resource,
      expiresAt: now + this.refreshTokenTtlSeconds,
    })
    this.persistState()

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.length > 0 ? scopes.join(" ") : undefined,
    }
  }

  /** Verifies an issued access token, returning its auth info or throwing. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const authInfo = this.getValidAccessToken(token)
    if (!authInfo) {
      throw new InvalidTokenError("Invalid or expired access token")
    }
    return authInfo
  }

  /**
   * Non-throwing lookup of a valid, unexpired access token. Returns
   * `undefined` when the token is unknown or expired (and prunes expired
   * entries).
   */
  public getValidAccessToken(token: string): AuthInfo | undefined {
    const authInfo = this.accessTokens.get(token)
    if (!authInfo) {
      return undefined
    }
    if (authInfo.expiresAt !== undefined && authInfo.expiresAt < Math.floor(Date.now() / 1000)) {
      this.accessTokens.delete(token)
      return undefined
    }
    return authInfo
  }

  /** Revokes an access or refresh token. */
  async revokeToken(
    _client: OAuthClientInformationFull,
    request: { token: string; token_type_hint?: string },
  ): Promise<void> {
    if (!request.token) {
      throw new ServerError("Missing token to revoke")
    }
    this.accessTokens.delete(request.token)
    this.refreshTokens.delete(request.token)
    this.persistState()
  }
}
