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
  it a long random secret. If it is unset, the HTTP transport serves every
  request unauthenticated — the server logs a loud warning, but it will run.
- **Do not put Cloudflare Access or another identity-aware proxy in front.**
  It breaks the MCP OAuth flow (see [`docs/architecture.md`](./docs/architecture.md)),
  so the token _is_ the access control. Compensate with token length, not with
  a proxy that cannot work here.
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
  feature".
- **Prompt injection is in scope for confidentiality, not integrity.** A
  recording's transcript is untrusted text that an LLM will read. It cannot
  change Riffado's data, but it can try to influence the client. Nothing in
  this server can prevent that; be aware of it when connecting a client that
  also has write access to other systems.
- **OAuth state at rest.** `HTTP_OAUTH_STATE_FILE` holds issued access and
  refresh tokens in plaintext JSON. Keep it on a volume only the container
  user can read.
