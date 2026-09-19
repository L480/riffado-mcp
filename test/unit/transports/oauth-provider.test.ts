import fs from "fs"
import os from "os"
import path from "path"
import { randomBytes } from "crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
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
