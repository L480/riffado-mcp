import { describe, expect, it, vi } from "vitest"
import { createPool, timestampToIsoUtc } from "../../../src/riffado/db.js"

describe("createPool", () => {
  it("registers an 'error' listener so an idle client error never crashes the process", () => {
    const pool = createPool({
      connectionString: "postgresql://user:secret-password@localhost:5432/riffado",
      statementTimeoutMs: 5000,
    })

    expect(pool.listenerCount("error")).toBeGreaterThan(0)
    expect(() => pool.emit("error", new Error("connection terminated unexpectedly"))).not.toThrow()

    pool.removeAllListeners()
  })

  it("logs the idle client error's message to stderr without the connection string", () => {
    const pool = createPool({
      connectionString: "postgresql://user:secret-password@localhost:5432/riffado",
      statementTimeoutMs: 5000,
    })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    pool.emit("error", new Error("connection terminated unexpectedly"))

    expect(errorSpy).toHaveBeenCalled()
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
    expect(logged).toContain("connection terminated unexpectedly")
    expect(logged).not.toContain("secret-password")

    errorSpy.mockRestore()
    pool.removeAllListeners()
  })
})

describe("timestampToIsoUtc", () => {
  it("converts a no-tz timestamp string to ISO 8601 UTC", () => {
    expect(timestampToIsoUtc("2026-01-01 00:00:00")).toBe("2026-01-01T00:00:00.000Z")
  })
})
