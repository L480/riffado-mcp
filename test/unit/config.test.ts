import { describe, expect, it } from "vitest"
import { loadConfig } from "../../src/config.js"

const BASE_ENV = {
  DATABASE_URL: "postgresql://postgres:pw@riffado-db:5432/riffado",
  ENCRYPTION_KEY: "a".repeat(64),
}

describe("loadConfig", () => {
  it("parses with just the required vars, applying defaults", () => {
    const config = loadConfig(BASE_ENV)
    expect(config.DATABASE_URL).toBe(BASE_ENV.DATABASE_URL)
    expect(config.TRANSPORT).toBe("stdio")
    expect(config.HTTP_PORT).toBe(3000)
    expect(config.HTTP_HOST).toBe("localhost")
    expect(config.CACHE_TTL_MS).toBe(60000)
    expect(config.DB_STATEMENT_TIMEOUT_MS).toBe(10000)
  })

  it("requires DATABASE_URL", () => {
    const { DATABASE_URL: _omit, ...rest } = BASE_ENV
    expect(() => loadConfig(rest)).toThrow()
  })

  it("requires ENCRYPTION_KEY", () => {
    const { ENCRYPTION_KEY: _omit, ...rest } = BASE_ENV
    expect(() => loadConfig(rest)).toThrow()
  })

  it("rejects an ENCRYPTION_KEY that isn't 64 hex chars", () => {
    expect(() => loadConfig({ ...BASE_ENV, ENCRYPTION_KEY: "not-hex" })).toThrow()
    expect(() => loadConfig({ ...BASE_ENV, ENCRYPTION_KEY: "a".repeat(63) })).toThrow()
    expect(() => loadConfig({ ...BASE_ENV, ENCRYPTION_KEY: "g".repeat(64) })).toThrow()
  })

  it("accepts a valid 64-hex-char ENCRYPTION_KEY", () => {
    expect(() => loadConfig({ ...BASE_ENV, ENCRYPTION_KEY: "F".repeat(64) })).not.toThrow()
  })

  describe("HTTP_TRUST_PROXY coercion", () => {
    it("defaults to false (X-Forwarded-For not trusted unless configured)", () => {
      expect(loadConfig(BASE_ENV).HTTP_TRUST_PROXY).toBe(false)
    })

    it("coerces 'true'/'false'", () => {
      expect(loadConfig({ ...BASE_ENV, HTTP_TRUST_PROXY: "true" }).HTTP_TRUST_PROXY).toBe(true)
      expect(loadConfig({ ...BASE_ENV, HTTP_TRUST_PROXY: "false" }).HTTP_TRUST_PROXY).toBe(false)
    })

    it("coerces a numeric string to a number", () => {
      expect(loadConfig({ ...BASE_ENV, HTTP_TRUST_PROXY: "2" }).HTTP_TRUST_PROXY).toBe(2)
    })

    it("rejects an oversized hop count instead of trusting every hop", () => {
      expect(loadConfig({ ...BASE_ENV, HTTP_TRUST_PROXY: "10" }).HTTP_TRUST_PROXY).toBe(10)
      expect(() => loadConfig({ ...BASE_ENV, HTTP_TRUST_PROXY: "11" })).toThrow(/hop count/)
      expect(() => loadConfig({ ...BASE_ENV, HTTP_TRUST_PROXY: "9".repeat(400) })).toThrow(
        /hop count/,
      )
    })

    it("passes through a subnet/preset string unchanged", () => {
      expect(loadConfig({ ...BASE_ENV, HTTP_TRUST_PROXY: "loopback" }).HTTP_TRUST_PROXY).toBe(
        "loopback",
      )
    })
  })

  it("rejects an invalid RIFFADO_APP_URL", () => {
    expect(() => loadConfig({ ...BASE_ENV, RIFFADO_APP_URL: "not a url" })).toThrow()
  })

  it("accepts a valid RIFFADO_APP_URL", () => {
    const config = loadConfig({ ...BASE_ENV, RIFFADO_APP_URL: "https://riffado.example.com" })
    expect(config.RIFFADO_APP_URL).toBe("https://riffado.example.com")
  })

  it("rejects an unknown TRANSPORT", () => {
    expect(() => loadConfig({ ...BASE_ENV, TRANSPORT: "carrier-pigeon" })).toThrow()
  })

  describe("HTTP_AUTH_TOKEN", () => {
    it("is optional for the stdio transport", () => {
      const config = loadConfig(BASE_ENV)
      expect(config.HTTP_AUTH_TOKEN).toBeUndefined()
    })

    it("is required for the HTTP transport (no unauthenticated mode)", () => {
      expect(() => loadConfig({ ...BASE_ENV, TRANSPORT: "http" })).toThrow(
        /HTTP_AUTH_TOKEN is required when TRANSPORT=http/,
      )
    })

    it("accepts the HTTP transport with a valid token", () => {
      const token = "a".repeat(32)
      const config = loadConfig({ ...BASE_ENV, TRANSPORT: "http", HTTP_AUTH_TOKEN: token })
      expect(config.TRANSPORT).toBe("http")
      expect(config.HTTP_AUTH_TOKEN).toBe(token)
    })

    it("rejects a short token on the HTTP transport too", () => {
      expect(() =>
        loadConfig({ ...BASE_ENV, TRANSPORT: "http", HTTP_AUTH_TOKEN: "a".repeat(31) }),
      ).toThrow(/at least 32 characters/)
    })

    it("rejects a token shorter than 32 characters", () => {
      expect(() => loadConfig({ ...BASE_ENV, HTTP_AUTH_TOKEN: "test" })).toThrow(
        /at least 32 characters/,
      )
      expect(() => loadConfig({ ...BASE_ENV, HTTP_AUTH_TOKEN: "a".repeat(31) })).toThrow(
        /at least 32 characters/,
      )
    })

    it("accepts a token that is exactly 32 characters", () => {
      const token = "a".repeat(32)
      expect(loadConfig({ ...BASE_ENV, HTTP_AUTH_TOKEN: token }).HTTP_AUTH_TOKEN).toBe(token)
    })
  })

  describe("HTTP_SESSION_TIMEOUT_MS", () => {
    it("defaults to one hour (3600000ms)", () => {
      expect(loadConfig(BASE_ENV).HTTP_SESSION_TIMEOUT_MS).toBe(3600000)
    })

    it("keeps 0 as a valid explicit opt-out (never expire idle sessions)", () => {
      expect(
        loadConfig({ ...BASE_ENV, HTTP_SESSION_TIMEOUT_MS: "0" }).HTTP_SESSION_TIMEOUT_MS,
      ).toBe(0)
    })
  })

  describe("numeric env vars", () => {
    it("parses valid integers (surrounding whitespace tolerated)", () => {
      const config = loadConfig({
        ...BASE_ENV,
        HTTP_PORT: " 8080 ",
        HTTP_SESSION_TIMEOUT_MS: "1000",
        CACHE_TTL_MS: "5000",
        DB_STATEMENT_TIMEOUT_MS: "2500",
      })
      expect(config.HTTP_PORT).toBe(8080)
      expect(config.HTTP_SESSION_TIMEOUT_MS).toBe(1000)
      expect(config.CACHE_TTL_MS).toBe(5000)
      expect(config.DB_STATEMENT_TIMEOUT_MS).toBe(2500)
    })

    it.each(["", "abc", "3000abc", "1.5", "-1", "1e3", "0x10"])(
      "rejects HTTP_PORT=%j instead of silently parseInt-ing it",
      (value) => {
        expect(() => loadConfig({ ...BASE_ENV, HTTP_PORT: value })).toThrow(/HTTP_PORT/)
      },
    )

    it("bounds HTTP_PORT to 1-65535", () => {
      expect(() => loadConfig({ ...BASE_ENV, HTTP_PORT: "0" })).toThrow(/HTTP_PORT/)
      expect(() => loadConfig({ ...BASE_ENV, HTTP_PORT: "65536" })).toThrow(/HTTP_PORT/)
      expect(loadConfig({ ...BASE_ENV, HTTP_PORT: "1" }).HTTP_PORT).toBe(1)
      expect(loadConfig({ ...BASE_ENV, HTTP_PORT: "65535" }).HTTP_PORT).toBe(65535)
    })

    it("requires CACHE_TTL_MS and DB_STATEMENT_TIMEOUT_MS to be positive", () => {
      expect(() => loadConfig({ ...BASE_ENV, CACHE_TTL_MS: "0" })).toThrow(/CACHE_TTL_MS/)
      expect(() => loadConfig({ ...BASE_ENV, DB_STATEMENT_TIMEOUT_MS: "0" })).toThrow(
        /DB_STATEMENT_TIMEOUT_MS/,
      )
      expect(() => loadConfig({ ...BASE_ENV, CACHE_TTL_MS: "-5" })).toThrow(/CACHE_TTL_MS/)
    })

    it("rejects timeouts above the 2^31-1 ms setTimeout limit", () => {
      expect(() => loadConfig({ ...BASE_ENV, HTTP_SESSION_TIMEOUT_MS: "2147483648" })).toThrow(
        /HTTP_SESSION_TIMEOUT_MS/,
      )
      expect(
        loadConfig({ ...BASE_ENV, HTTP_SESSION_TIMEOUT_MS: "2147483647" }).HTTP_SESSION_TIMEOUT_MS,
      ).toBe(2147483647)
    })

    it("rejects a non-integer HTTP_SESSION_TIMEOUT_MS", () => {
      expect(() => loadConfig({ ...BASE_ENV, HTTP_SESSION_TIMEOUT_MS: "1h" })).toThrow(
        /HTTP_SESSION_TIMEOUT_MS/,
      )
    })
  })
})
