# Security Policy

## Supported versions

Only the latest published release (image tags `latest` / `X.Y.Z`) is supported
with security fixes. There is no LTS branch.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.
Report privately via
[GitHub Security Advisories](https://github.com/L480/riffado-mcp/security/advisories/new).

Expect an initial response within a few days.

## Threat model of a deployment

This server hands an LLM client the full text of private voice recordings.
That makes the deployment, not just the code, part of the security surface:

- **`HTTP_AUTH_TOKEN` is the only thing protecting the HTTP transport.** Make
  it a long random secret — at least 32 characters, enforced at startup. It is
  mandatory with `TRANSPORT=http`: there is no unauthenticated mode, and the
  server refuses to start without it.
- **`GET /health` is liveness-only and unauthenticated by design** (status +
  timestamp, nothing else). Session count, DB reachability and cached
  recording count live at `GET /health/details`, which requires the same
  auth as every other route.
- **Do not put Cloudflare Access or another identity-aware proxy in front.**
  It breaks the MCP OAuth flow (see [`docs/architecture.md`](./docs/architecture.md)),
  so the token _is_ the access control. Compensate with token length, not with
  a proxy that cannot work here.
- **Set `HTTP_TRUST_PROXY` only when a proxy is actually in front.** It
  defaults to `false`; behind a reverse proxy or Cloudflare Tunnel set it to
  the hop count (usually `1`). Trusting `X-Forwarded-For` without a proxy lets
  any client spoof its IP and sidestep the per-IP rate limits. Those limits
  are: 50 failed authentications per IP per 15 minutes, after which that IP
  gets `429` on everything but `/health` until the window ends (valid
  credentials included); 1000 authenticated requests per IP per 15 minutes;
  30 requests per 15 minutes across `/register`, `/authorize` and `/token`.
  Behind a shared egress (e.g. Claude's connector infrastructure) a
  lockout applies to everyone behind that IP.
- **Serve it over HTTPS only.** OAuth issuer URLs must be HTTPS anyway (the
  server refuses to enable OAuth otherwise, outside `localhost`), and the
  bearer token is sent on every request.
- **`ENCRYPTION_KEY` decrypts the whole archive.** It is read from the
  environment and never written to disk by this server. Treat a leak of it as
  equivalent to a leak of every recording.
- **Reads cannot become writes.** The Postgres pool pins
  `default_transaction_read_only=on`, so the database itself rejects any
  mutation — including one coming from prompt injection in a transcript. This
  is a deliberate defence-in-depth boundary; do not remove it to "add a
  feature". Connect with a dedicated `SELECT`-only role as a second
  layer (example in the README), and use `sslmode=require` in `DATABASE_URL`
  whenever the database is reached over a network rather than the same
  host/Docker network.
- **Prompt injection is in scope for confidentiality, not integrity.** A
  recording's transcript is untrusted text that an LLM will read. It cannot
  change Riffado's data, but it can try to influence the client. Nothing in
  this server can prevent that; be aware of it when connecting a client that
  also has write access to other systems.
- **OAuth state at rest.** `HTTP_OAUTH_STATE_FILE` holds registered clients
  and issued grants, with every access and refresh token stored only as its
  SHA-256 hash, so a copy of the file can't be replayed as a bearer token.
  The server still writes it atomically at `0600`; keep it on a volume only
  the container user can read regardless. Expired tokens are pruned on every
  write. Access tokens live 1 hour, refresh tokens 90 days; each refresh
  rotates the refresh token, restarts its lifetime and revokes the access
  token issued with the old one, and may not widen the original scopes.
  Rotation and revocation must reach disk: if the state file can't be
  written, a refresh is rolled back (the old token keeps working, the client
  gets a server error and can retry) and a revocation is reported as failed
  instead of succeeding in memory only. Until such a revocation is written,
  no new grant (code exchange or refresh) is issued, so no revoked token can
  come back after a restart.
- **Upgrading from a pre-`version: 2` state file** (tokens stored unhashed)
  discards it on first start: every connector logs in again once.
- **Rotating `HTTP_AUTH_TOKEN` revokes every OAuth grant.** The state file
  stores an HMAC-SHA256 fingerprint of the token (never the token itself);
  on startup, state issued under a different token is discarded and the file
  rewritten, so every connector has to log in again with the new secret. This
  is the way to cut off a leaked access or refresh token.
- **The shared token never travels in a URL.** The OAuth login page only
  accepts it from a POST body (a `?mcp_auth_token=` query parameter is
  ignored), and the request log records the path only, never the query
  string, so authorization codes and `state` don't end up in logs either.
- **Redirect URIs are allowlisted.** `/register` is open, so without a check
  anyone could register a client with their own redirect URI and send you an
  authorize link that ends on their site. Registration only accepts redirect
  URIs whose hostname is in `HTTP_OAUTH_ALLOWED_REDIRECT_HOSTS` (default
  `claude.ai`, `claude.com` and loopback; exact hostnames, no wildcards),
  over `https` (plain `http` only for `localhost`/`127.0.0.1`/`[::1]`),
  without userinfo or fragment; anything else is refused with
  `invalid_redirect_uri`. Clients persisted before the list was narrowed are
  dropped on start. Keep the list short: every host on it can receive
  authorization codes.
- **Check the redirect host on the login page anyway.** It names the host
  the authorization code will be sent to; only enter the token if that is
  the client you expect (for Claude, `claude.ai`). The page is served with `X-Frame-Options: DENY`, a
  restrictive CSP (`frame-ancestors 'none'`, `form-action` limited to this
  server and that redirect origin), `Referrer-Policy: no-referrer` and
  `Cache-Control: no-store`; every response carries
  `X-Content-Type-Options: nosniff`.
- **OAuth client registration (`/register`) is unauthenticated by spec** —
  Claude's dynamic client registration has to be. The registry is capped
  (default 100 clients) so an anonymous caller can't grow it or the state
  file without bound. At the cap, only the oldest client holding no live
  grant (unexpired access token, refresh token or authorization code) is
  evicted, together with anything it owns; if every client holds one,
  registration is refused (`too_many_requests`). A registration flood
  therefore can't evict a logged-in connector. `/register`, `/authorize`,
  `/token` sit behind a tighter rate limit than the rest of the API.
