/**
 * Ported from the author's own L480/mcp-picnic fork
 * (src/transports/oauth-provider.ts), where this static-token-wrapped-in-
 * OAuth-2.1 approach was written to get Claude's custom connectors to
 * authenticate against a shared secret. Same shape, renamed for Riffado.
 */
import { Response } from "express"
import { createHash, createHmac, randomUUID, randomBytes, timingSafeEqual } from "crypto"
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
  CustomOAuthError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
  ServerError,
  TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js"

/**
 * Hosts OAuth clients may register redirect URIs for when
 * `HTTP_OAUTH_ALLOWED_REDIRECT_HOSTS` is unset: Claude's connector callback
 * (`https://claude.ai/api/mcp/auth_callback`, plus claude.com) and loopback
 * for local tools such as the MCP Inspector.
 */
export const DEFAULT_ALLOWED_REDIRECT_HOSTS: readonly string[] = [
  "claude.ai",
  "claude.com",
  "localhost",
  "127.0.0.1",
  "[::1]",
]

/** Loopback hosts, the only ones allowed to use plain `http:` redirect URIs
 * (RFC 8252 §7.3). Same set the SDK relaxes the port check for. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Canonicalises one allowlist entry to the form `URL#hostname` produces
 * (lowercase, punycode, bracketed IPv6), so matching is a plain set lookup
 * against the parsed redirect URI. Throws on anything that isn't a bare
 * hostname: wildcards (`*`, `*.example.com`) are deliberately unsupported,
 * as are ports, paths and userinfo. Error messages deliberately don't echo
 * the entry: they end up in startup logs, and callers point at the entry
 * by position instead.
 */
export function normalizeRedirectHost(entry: string): string {
  let host = entry.trim().toLowerCase()
  if (host.length === 0) {
    throw new Error("empty host entry")
  }
  if (host.includes("*")) {
    throw new Error("wildcards are not supported")
  }
  // A bare IPv6 literal ("::1") is accepted and bracketed like URL does.
  if (host.includes(":") && !host.startsWith("[")) {
    host = `[${host}]`
  }
  let parsed: URL
  try {
    parsed = new URL(`http://${host}/`)
  } catch {
    throw new Error("not a valid hostname")
  }
  if (
    parsed.hostname === "" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    // Only a host that round-trips unchanged is unambiguous: URL parsing
    // would otherwise silently rewrite e.g. "127.1" to "127.0.0.1".
    host !== parsed.hostname
  ) {
    throw new Error("expected a bare hostname without port, path or userinfo")
  }
  return parsed.hostname
}

/**
 * Why `redirectUri` may not be registered under `allowedHosts` (already
 * normalised), or `undefined` if it may. Requires `https:` — or `http:` for
 * loopback hosts — an allowlisted hostname (compared exactly, so
 * `https://claude.ai@evil.example/` is `evil.example`, and `claude.ai.` is
 * not `claude.ai`), no userinfo and no fragment (RFC 6749 §3.1.2).
 */
export function redirectUriRejection(
  redirectUri: string,
  allowedHosts: ReadonlySet<string>,
): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(redirectUri)
  } catch {
    return "is not a valid URL"
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname)
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    return "must use https (http is only allowed for loopback hosts)"
  }
  // WHATWG URL drops an *empty* userinfo ("https://@claude.ai/"), leaving
  // username/password blank, so "@" is also checked in the raw authority.
  // That only works if the raw string parses the way it reads: URL trims
  // surrounding whitespace, strips tabs/newlines anywhere, treats "\\" as
  // "/" and skips extra slashes. So reject all of those outright, and
  // require exactly "scheme://" followed by the authority.
  const hasControlChar = [...redirectUri].some((ch) => {
    const code = ch.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })
  if (hasControlChar || /[\s\\]/.test(redirectUri)) {
    return "must not contain whitespace, control characters or backslashes"
  }
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(redirectUri)?.[1]
  if (authority === undefined) {
    return "must be an absolute URL of the form scheme://host/..."
  }
  if (parsed.username !== "" || parsed.password !== "" || authority.includes("@")) {
    return "must not contain userinfo"
  }
  if (redirectUri.includes("#")) {
    return "must not contain a fragment"
  }
  if (!allowedHosts.has(parsed.hostname)) {
    return `host "${parsed.hostname}" is not in HTTP_OAUTH_ALLOWED_REDIRECT_HOSTS`
  }
  return undefined
}

/** SHA-256 (hex) of an issued token: the only form tokens are indexed and
 * persisted under, so the state file never holds a usable bearer token. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** Configuration for the static-token OAuth provider. */
export interface StaticTokenOAuthOptions {
  /** The shared secret token that gates access to the MCP server. */
  authToken: string
  /** Absolute URL of the authorization endpoint, used as the login form target. */
  authorizeEndpoint: string
  /** RFC 8707 resource identifier advertised for issued tokens. */
  resource?: string
  /** Lifetime of issued access tokens in seconds (default: 1 hour). */
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
   * bound. Once at capacity, the oldest client holding no live grant is
   * evicted to make room; if every client holds one, registration fails.
   */
  maxClients?: number
  /**
   * Hostnames registered redirect URIs may point at (default:
   * `DEFAULT_ALLOWED_REDIRECT_HOSTS`). Entries are normalised with
   * `normalizeRedirectHost`; wildcards are not supported.
   */
  allowedRedirectHosts?: readonly string[]
}

/** Current state-file format. Files with any other `version` (including
 * none: the v1 format keyed tokens by their raw value) are discarded. */
const STATE_VERSION = 2

interface PersistedState {
  version: typeof STATE_VERSION
  /**
   * HMAC of the shared token the state was issued under (never the token
   * itself). On load, a missing or different value means `HTTP_AUTH_TOKEN`
   * was rotated since, and everything in the file is discarded — rotating
   * the secret must also revoke every OAuth grant obtained with the old one.
   */
  authTokenFingerprint?: string
  clients: [string, OAuthClientInformationFull][]
  /** Keyed by `hashToken(accessToken)`. */
  accessTokens: [string, StoredAccessToken][]
  /** Keyed by `hashToken(refreshToken)`. */
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

interface StoredAccessToken {
  clientId: string
  scopes: string[]
  resource?: string
  /** Expiry as epoch seconds, same unit as `AuthInfo.expiresAt`. */
  expiresAt: number
}

interface StoredRefreshToken {
  clientId: string
  scopes: string[]
  resource?: string
  /** Expiry as epoch seconds, same unit as `AuthInfo.expiresAt`. */
  expiresAt: number
  /** Hash of the access token issued together with this refresh token,
   * revoked when this refresh token is used or revoked. */
  accessTokenHash?: string
}

const isSha256Hex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value)

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string")

/**
 * Thrown when the state file exists but can't be verified or cleared: it
 * may hold grants issued under a previous auth token, so the server must
 * not start (a later restart with that token would resurrect them).
 */
export class StaleStateFileError extends Error {}

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
  private readonly allowedRedirectHosts: ReadonlySet<string>

  private readonly clients = new Map<string, OAuthClientInformationFull>()
  private readonly authorizationCodes = new Map<string, StoredAuthorizationCode>()
  /** Keyed by `hashToken(accessToken)`, never the token itself. */
  private readonly accessTokens = new Map<string, StoredAccessToken>()
  /** Keyed by `hashToken(refreshToken)`, never the token itself. */
  private readonly refreshTokens = new Map<string, StoredRefreshToken>()

  constructor(options: StaticTokenOAuthOptions) {
    this.authTokenBuffer = Buffer.from(options.authToken)
    this.authTokenFingerprint = fingerprintAuthToken(options.authToken)
    this.authorizeEndpoint = options.authorizeEndpoint
    this.resource = options.resource
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 60 * 60
    this.refreshTokenTtlSeconds = options.refreshTokenTtlSeconds ?? 90 * 24 * 60 * 60
    this.authorizationCodeTtlSeconds = options.authorizationCodeTtlSeconds ?? 5 * 60
    this.serverName = options.serverName ?? "Riffado MCP"
    this.stateFile = options.stateFile
    this.maxClients = options.maxClients ?? 100
    this.allowedRedirectHosts = new Set(
      (options.allowedRedirectHosts ?? DEFAULT_ALLOWED_REDIRECT_HOSTS).map(normalizeRedirectHost),
    )
    this.loadState()
  }

  public readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId: string) => this.clients.get(clientId),
    registerClient: (client) => {
      // Validated before anything is evicted, so a rejected registration
      // can't cost an existing client its slot. The SDK's register handler
      // turns an OAuthError into a 400 carrying its error code.
      this.assertRedirectUrisAllowed(client.redirect_uris)
      while (this.clients.size >= this.maxClients) {
        this.evictOldestIdleClient()
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

  /** Throws RFC 7591's `invalid_redirect_uri` unless every redirect URI is
   * allowed (and there is at least one: only the code flow is supported). */
  private assertRedirectUrisAllowed(redirectUris: unknown): void {
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      throw new CustomOAuthError("invalid_redirect_uri", "At least one redirect_uri is required")
    }
    for (const uri of redirectUris) {
      const reason =
        typeof uri === "string"
          ? redirectUriRejection(uri, this.allowedRedirectHosts)
          : "is not a string"
      if (reason) {
        throw new CustomOAuthError("invalid_redirect_uri", `redirect_uri ${reason}`)
      }
    }
  }

  /** Whether every redirect URI of a (persisted) client is still allowed. */
  private redirectUrisAllowed(client: OAuthClientInformationFull): boolean {
    try {
      this.assertRedirectUrisAllowed(client.redirect_uris)
      return true
    } catch {
      return false
    }
  }

  /**
   * Makes room under `maxClients` by evicting the oldest client (by
   * `client_id_issued_at`) that holds no live grant — no unexpired access
   * token, refresh token or authorization code. `/register` is
   * unauthenticated, so evicting regardless of grants would let anyone
   * flood registrations until the real connector's client is evicted and
   * its next refresh fails. A client with a live grant was, by
   * construction, authorized with the shared token, so those are never
   * evicted: once every slot holds one, registration is refused instead
   * (the cap is far above what a single-user server needs).
   *
   * Anything the evicted client still owns (only expired grants, by the
   * above) is dropped with it, so no token outlives its client.
   */
  private evictOldestIdleClient(): void {
    const withLiveGrant = this.clientIdsWithLiveGrants()
    let oldestId: string | undefined
    let oldestIssuedAt = Infinity
    for (const [id, client] of this.clients) {
      if (withLiveGrant.has(id)) {
        continue
      }
      const issuedAt = client.client_id_issued_at ?? 0
      if (issuedAt < oldestIssuedAt) {
        oldestIssuedAt = issuedAt
        oldestId = id
      }
    }
    if (oldestId === undefined) {
      throw new TooManyRequestsError(
        "Client registration limit reached and every registered client holds an active grant",
      )
    }
    this.removeClient(oldestId)
  }

  /** Client IDs that currently hold an unexpired token or authorization code. */
  private clientIdsWithLiveGrants(): Set<string> {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const live = new Set<string>()
    for (const token of this.accessTokens.values()) {
      if (token.expiresAt > nowSeconds) live.add(token.clientId)
    }
    for (const token of this.refreshTokens.values()) {
      if (token.expiresAt > nowSeconds) live.add(token.clientId)
    }
    const nowMs = Date.now()
    for (const code of this.authorizationCodes.values()) {
      if (code.expiresAt > nowMs) live.add(code.clientId)
    }
    return live
  }

  /** Removes a client together with every token and code it owns. */
  private removeClient(clientId: string): void {
    this.clients.delete(clientId)
    for (const map of [this.accessTokens, this.refreshTokens, this.authorizationCodes]) {
      for (const [key, grant] of map) {
        if (grant.clientId === clientId) map.delete(key)
      }
    }
  }

  /**
   * Loads previously persisted clients and tokens from `stateFile`, if
   * configured. Reads synchronously so state is available before the
   * server starts accepting requests. Missing or corrupt files are treated
   * as "no prior state" rather than a fatal error.
   *
   * State issued under a different shared token (fingerprint mismatch, or
   * no fingerprint at all) or in an older format (no `version: 2`: tokens
   * keyed by their raw value) is discarded wholesale and the file
   * rewritten empty, so rotating `HTTP_AUTH_TOKEN` revokes every client and
   * token obtained with the old one. Expired tokens, clients whose redirect
   * URIs are no longer allowed, and tokens of dropped clients are dropped
   * too.
   */
  private loadState(): void {
    if (!this.stateFile) {
      return
    }

    let raw: string
    try {
      raw = fs.readFileSync(this.stateFile, "utf-8")
    } catch (error) {
      // Only a missing file means "no prior state". Any other read error
      // leaves a file whose fingerprint we can't check on disk, so fail
      // closed rather than start and let it be trusted on a later restart.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new StaleStateFileError(
        `Could not read OAuth state file ${this.stateFile} (${message}). Refusing to start: ` +
          `its token fingerprint can't be verified. Fix its permissions or delete it.`,
      )
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      const now = Math.floor(Date.now() / 1000)

      if (parsed.version !== STATE_VERSION) {
        console.error(
          `Discarding OAuth state from ${this.stateFile}: it uses an older format ` +
            `(tokens stored unhashed). All previously registered clients and issued ` +
            `tokens are revoked; connectors must log in again once.`,
        )
        this.discardStaleStateFile()
        return
      }

      if (!this.fingerprintMatches(parsed.authTokenFingerprint)) {
        console.error(
          `Discarding OAuth state from ${this.stateFile}: it was issued under a different ` +
            `HTTP_AUTH_TOKEN (or predates token fingerprinting). All previously registered ` +
            `clients and issued tokens are revoked; connectors must log in again.`,
        )
        this.discardStaleStateFile()
        return
      }

      let droppedClients = 0
      for (const [clientId, client] of parsed.clients ?? []) {
        // HTTP_OAUTH_ALLOWED_REDIRECT_HOSTS may have been narrowed since
        // (or the client predates it): such a client could still be sent
        // through /authorize to a host that is no longer trusted.
        if (!this.redirectUrisAllowed(client)) {
          droppedClients++
          continue
        }
        this.clients.set(clientId, client)
      }
      if (droppedClients > 0) {
        console.error(
          `Dropped ${droppedClients} persisted OAuth client(s) whose redirect URIs are no ` +
            `longer allowed by HTTP_OAUTH_ALLOWED_REDIRECT_HOSTS.`,
        )
      }

      // Tokens are only kept for clients that survived above, so none
      // outlives its client. A missing/non-numeric expiresAt can only come
      // from a hand-edited or foreign file; it counts as expired rather
      // than "never expires".
      const isLive = (grant: unknown): grant is StoredAccessToken => {
        const g = grant as Partial<StoredAccessToken> | null
        return (
          typeof g === "object" &&
          g !== null &&
          typeof g.clientId === "string" &&
          this.clients.has(g.clientId) &&
          isStringArray(g.scopes) &&
          typeof g.expiresAt === "number" &&
          g.expiresAt > now &&
          // getValidAccessToken turns this into a URL; a malformed value
          // would make every request with the token throw.
          (g.resource === undefined || (typeof g.resource === "string" && URL.canParse(g.resource)))
        )
      }
      for (const [hash, accessToken] of parsed.accessTokens ?? []) {
        if (isSha256Hex(hash) && isLive(accessToken)) {
          this.accessTokens.set(hash, accessToken)
        }
      }
      for (const [hash, refreshToken] of parsed.refreshTokens ?? []) {
        if (isSha256Hex(hash) && isLive(refreshToken)) {
          this.refreshTokens.set(hash, refreshToken as StoredRefreshToken)
        }
      }
      console.error(
        `Restored OAuth state from ${this.stateFile} (${this.clients.size} client(s), ` +
          `${this.accessTokens.size} access token(s), ${this.refreshTokens.size} refresh token(s)).`,
      )
      if (droppedClients > 0) {
        this.persistState()
      }
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
   * Tokens are stored only as SHA-256 hashes, so the file can't be replayed
   * as bearer tokens, but it still lists every client and grant, so it
   * lands at 0600, and a crash mid-write must not corrupt existing state. Both
   * come from writing a uniquely-named temp file (mode set at creation —
   * `writeFileSync`'s `mode` option is only applied when the file doesn't
   * already exist yet, so writing in place over the target, or over a
   * reused temp filename, would silently keep whatever permissions were
   * already there) and `renameSync`-ing it over the target, which is
   * atomic on the same filesystem.
   */
  /**
   * Hashes of tokens revoked in memory whose revocation hasn't reached the
   * state file yet (the write failed), so the file could still revive
   * them on restart. A retried revocation of one of these rewrites the
   * file; unknown/foreign tokens stay a no-op. While any are pending, no
   * new grant is issued (see `ensureRevocationsPersisted`). Cleared by the
   * next successful write.
   */
  private readonly pendingRevocations = new Map<string, string>() // token hash -> client id

  private persistState(): boolean {
    // Pruned even without a state file, so expired tokens never accumulate
    // in memory either.
    this.pruneExpiredTokens()

    if (!this.stateFile) {
      return true
    }

    const state: PersistedState = {
      version: STATE_VERSION,
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
      this.pendingRevocations.clear()
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

  /**
   * Refuses to issue a new grant while a revocation hasn't reached the
   * state file: the grant's own write could fail as well, and the process
   * would keep serving on a file that still revives revoked tokens on
   * restart. Retries the write first, so a recovered disk unblocks at once.
   */
  private ensureRevocationsPersisted(): void {
    if (this.pendingRevocations.size > 0 && !this.persistState()) {
      throw new ServerError(
        "A token revocation has not been persisted yet; no new grants until the state file is writable",
      )
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
    for (const map of [this.accessTokens, this.refreshTokens]) {
      for (const [hash, token] of map) {
        if (token.expiresAt <= now) map.delete(hash)
      }
    }
  }

  /** Drops expired authorization codes. They are never persisted, so this
   * only bounds memory; called whenever a new code is issued. */
  private pruneExpiredAuthorizationCodes(): void {
    const now = Date.now()
    for (const [code, stored] of this.authorizationCodes) {
      if (stored.expiresAt <= now) this.authorizationCodes.delete(code)
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

    this.pruneExpiredAuthorizationCodes()
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
    // Before consuming the code, so a blocked exchange can be retried.
    this.ensureRevocationsPersisted()
    this.authorizationCodes.delete(authorizationCode)

    if (stored.expiresAt <= Date.now()) {
      throw new InvalidGrantError("Authorization code has expired")
    }
    if (redirectUri !== undefined && redirectUri !== stored.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request")
    }

    return this.issueTokens(client.client_id, stored.scopes, stored.resource)
  }

  /**
   * Exchanges a refresh token for a new access/refresh token pair. The
   * refresh token rotates, and the access token issued alongside it is
   * revoked, so each grant has at most one live pair. Requested scopes must
   * be a subset of the original grant (RFC 6749 §6); none means the
   * original scopes.
   */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const hash = hashToken(refreshToken)
    const stored = this.refreshTokens.get(hash)
    if (!stored || stored.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token")
    }

    if (stored.expiresAt <= Math.floor(Date.now() / 1000)) {
      // Only the expired refresh token is dropped, not its paired access
      // token (that one expires on its own). Nothing is revoked here, so a
      // failed write can't resurrect anything: the refresh token is expired
      // on disk too and is dropped again on load.
      this.refreshTokens.delete(hash)
      this.persistState()
      throw new InvalidGrantError("Refresh token has expired")
    }

    // The SDK splits `scope` on single spaces, so "a  b" yields "".
    const requested = (scopes ?? []).filter((scope) => scope.length > 0)
    const granted = new Set(stored.scopes)
    const excess = requested.filter((scope) => !granted.has(scope))
    if (excess.length > 0) {
      // Checked before rotating: an invalid_scope request leaves the
      // refresh token usable.
      throw new InvalidScopeError(`Scope exceeds the original grant: ${excess.join(" ")}`)
    }

    this.ensureRevocationsPersisted()

    // Rotate transactionally: if the new state can't be written, the old
    // pair would still be on disk and come back after a restart, so roll
    // the in-memory maps back instead and fail the refresh. The client can
    // retry with the same (still valid) refresh token.
    const oldAccessHash = stored.accessTokenHash
    const oldAccess = oldAccessHash ? this.accessTokens.get(oldAccessHash) : undefined
    this.revokeRefreshToken(hash)
    const grantedScopes = requested.length > 0 ? [...new Set(requested)] : stored.scopes
    const issued = this.issueTokens(client.client_id, grantedScopes, stored.resource, {
      persist: false,
    })
    if (!this.persistState()) {
      this.accessTokens.delete(issued.accessTokenHash)
      this.refreshTokens.delete(issued.refreshTokenHash)
      this.refreshTokens.set(hash, stored)
      if (oldAccessHash && oldAccess) {
        this.accessTokens.set(oldAccessHash, oldAccess)
      }
      throw new ServerError("Could not persist rotated tokens; retry the refresh")
    }
    return issued.tokens
  }

  /** Deletes a refresh token and the access token issued with it. */
  private revokeRefreshToken(hash: string): void {
    const stored = this.refreshTokens.get(hash)
    if (!stored) {
      return
    }
    this.refreshTokens.delete(hash)
    if (stored.accessTokenHash) {
      this.accessTokens.delete(stored.accessTokenHash)
    }
  }

  /** Issues a new access token (and rotating refresh token) for a client. */
  private issueTokens(clientId: string, scopes: string[], resource?: string): OAuthTokens
  private issueTokens(
    clientId: string,
    scopes: string[],
    resource: string | undefined,
    options: { persist: false },
  ): { tokens: OAuthTokens; accessTokenHash: string; refreshTokenHash: string }
  private issueTokens(
    clientId: string,
    scopes: string[],
    resource?: string,
    options?: { persist: false },
  ): OAuthTokens | { tokens: OAuthTokens; accessTokenHash: string; refreshTokenHash: string } {
    const accessToken = base64url(randomBytes(32))
    const refreshToken = base64url(randomBytes(32))
    const accessTokenHash = hashToken(accessToken)
    const now = Math.floor(Date.now() / 1000)

    this.accessTokens.set(accessTokenHash, {
      clientId,
      scopes,
      expiresAt: now + this.accessTokenTtlSeconds,
      resource: resource ?? this.resource,
    })
    const refreshTokenHash = hashToken(refreshToken)
    this.refreshTokens.set(refreshTokenHash, {
      clientId,
      scopes,
      resource,
      expiresAt: now + this.refreshTokenTtlSeconds,
      accessTokenHash,
    })

    const tokens: OAuthTokens = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.length > 0 ? scopes.join(" ") : undefined,
    }
    if (options?.persist === false) {
      return { tokens, accessTokenHash, refreshTokenHash }
    }
    // Best-effort for a fresh grant: a failed write only loses the new
    // grant on restart (the connector logs in again), it never revives one.
    this.persistState()
    return tokens
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
   * entries). Only the hash is stored, so `token` in the result is the
   * presented token itself.
   */
  public getValidAccessToken(token: string): AuthInfo | undefined {
    const hash = hashToken(token)
    const stored = this.accessTokens.get(hash)
    if (!stored) {
      return undefined
    }
    if (stored.expiresAt <= Math.floor(Date.now() / 1000)) {
      this.accessTokens.delete(hash)
      return undefined
    }
    return {
      token,
      clientId: stored.clientId,
      scopes: [...stored.scopes],
      expiresAt: stored.expiresAt,
      resource: stored.resource ? new URL(stored.resource) : undefined,
    }
  }

  /**
   * Revokes an access or refresh token (RFC 7009). Only tokens issued to
   * the requesting client are revoked; anything else is ignored, which the
   * RFC's "respond 200 for invalid tokens" makes indistinguishable to the
   * caller. Revoking a refresh token also revokes its paired access token.
   */
  async revokeToken(
    client: OAuthClientInformationFull,
    request: { token: string; token_type_hint?: string },
  ): Promise<void> {
    if (!request.token) {
      throw new ServerError("Missing token to revoke")
    }
    const hash = hashToken(request.token)
    let revoked = false
    if (this.accessTokens.get(hash)?.clientId === client.client_id) {
      this.accessTokens.delete(hash)
      revoked = true
    }
    if (this.refreshTokens.get(hash)?.clientId === client.client_id) {
      this.revokeRefreshToken(hash)
      revoked = true
    }
    // Unknown or foreign tokens are a successful no-op (RFC 7009), with no
    // write attempted. The one exception is this client retrying a
    // revocation whose earlier write failed: the token is already gone from
    // memory, but the file still holds it, so it must be rewritten. A
    // revocation stays in effect in memory either way (rolling it back
    // would re-enable a token the client asked to kill), but until it's
    // written it could come back after a restart (nothing durable can
    // prevent that while the disk is failing), so that's reported
    // instead of a false success.
    const retryingPending = this.pendingRevocations.get(hash) === client.client_id
    if ((revoked || retryingPending) && !this.persistState()) {
      this.pendingRevocations.set(hash, client.client_id)
      throw new ServerError("Token revoked in memory but could not be persisted; retry")
    }
  }
}
