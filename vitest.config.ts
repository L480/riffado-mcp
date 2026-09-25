import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // Pure wiring: parses env, builds the pool/store/transport and wires
      // signal handlers, then calls `main()` at module scope -- there's no
      // exported unit to call, and testing it means mocking process exit/
      // signals for no real coverage of behavior tested elsewhere (db.ts,
      // store.ts, config.ts, transports/*).
      exclude: ["src/index.ts"],
      thresholds: {
        lines: 85,
        branches: 75,
        functions: 85,
        statements: 85,
      },
    },
  },
})
