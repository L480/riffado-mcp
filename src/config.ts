import { z } from "zod"
import os from "os"
import path from "path"
import dotenv from "dotenv"

// `quiet: true` matters here, not just for tidy logs: dotenv >=16.4 writes a
// banner to stdout by default, and stdout is the JSON-RPC channel on the
// stdio transport — an unsuppressed banner would corrupt every message.
dotenv.config({ quiet: true })

const defaultOAuthStateFile = path.join(os.homedir(), ".riffado-mcp-oauth-state.json")

const isValidUrl = (value: string): boolean => {
  try {
    return Boolean(new URL(value))
  } catch {
    return false
  }
}

const boolFromString = (defaultValue: "true" | "false") =>
  z
    .string()
    .default(defaultValue)
    .transform((val) => val === "true")

const trustProxyCoercion = z
  .string()
  .default("1")
  .transform((val): boolean | number | string => {
    if (val === "true") return true
    if (val === "false" || val === "") return false
    if (/^\d+$/.test(val)) return parseInt(val, 10)
    return val
  })

const configSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY must be exactly 64 hex characters"),
    RIFFADO_USER_ID: z.string().optional(),
    RIFFADO_APP_URL: z
      .string()
      .refine(isValidUrl, "RIFFADO_APP_URL must be a valid URL")
      .optional(),
    TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
    HTTP_PORT: z
      .string()
      .default("3000")
      .transform((val) => parseInt(val, 10)),
    HTTP_HOST: z.string().default("localhost"),
    // Required when TRANSPORT=http (enforced below) — it's the sole access
    // control over the whole archive, so there is no unauthenticated mode,
    // and a short value like "test" must not be accepted. Unused on stdio.
    HTTP_AUTH_TOKEN: z
      .string()
      .min(32, "HTTP_AUTH_TOKEN must be at least 32 characters when set")
      .optional(),
    HTTP_AUTH_HEADER_NAME: z.string().default("x-mcp-token"),
    HTTP_OAUTH_ENABLED: boolFromString("true"),
    HTTP_PUBLIC_URL: z
      .string()
      .refine(isValidUrl, "HTTP_PUBLIC_URL must be a valid URL")
      .optional(),
    HTTP_OAUTH_STATE_FILE: z.string().default(defaultOAuthStateFile),
    HTTP_TRUST_PROXY: trustProxyCoercion,
    // Default 1h idle expiry. `0` remains a valid explicit opt-out that
    // disables idle expiry entirely (sessions only end on protocol
    // close/DELETE) — see README.
    HTTP_SESSION_TIMEOUT_MS: z
      .string()
      .default("3600000")
      .transform((val) => parseInt(val, 10)),
    CACHE_TTL_MS: z
      .string()
      .default("60000")
      .transform((val) => parseInt(val, 10)),
    DB_STATEMENT_TIMEOUT_MS: z
      .string()
      .default("10000")
      .transform((val) => parseInt(val, 10)),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.TRANSPORT === "http" && !cfg.HTTP_AUTH_TOKEN) {
      ctx.addIssue({
        code: "custom",
        path: ["HTTP_AUTH_TOKEN"],
        message:
          "HTTP_AUTH_TOKEN is required when TRANSPORT=http (at least 32 characters; " +
          "generate one with `openssl rand -hex 32`)",
      })
    }
  })

export type Config = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env)
}
