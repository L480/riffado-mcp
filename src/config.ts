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

// Largest delay `setTimeout` honours: anything above 2^31-1 ms overflows and
// fires after ~1ms instead, which would turn a "very long" idle timeout
// into "expire immediately". Also used as a sane upper bound for the other
// millisecond settings (Postgres caps statement_timeout at INT_MAX too).
const MAX_TIMER_MS = 2_147_483_647

/**
 * Strict integer parsing for numeric env vars. Env values are always
 * strings, so this keeps the string-in/number-out shape of the old
 * `parseInt` transforms, but rejects what `parseInt` silently accepted:
 * `""` (NaN), `"3000abc"` (3000), `"1.5"` (1), `"-1"`, `"1e3"` (1).
 */
const intFromEnv = (name: string, defaultValue: string, min: number, max: number) =>
  z
    .string()
    .default(defaultValue)
    .transform((val, ctx) => {
      const trimmed = val.trim()
      const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
      if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({
          code: "custom",
          message: `${name} must be an integer between ${min} and ${max}, got "${val}"`,
        })
        return z.NEVER
      }
      return parsed
    })

// Default `false`, matching StreamableHttpServer's own default: trusting
// X-Forwarded-For when no proxy is actually in front lets any client spoof
// its IP and dodge the per-IP rate limits. Set it (e.g. `1`) explicitly
// when running behind a reverse proxy or Cloudflare Tunnel.
// More proxy hops than any real deployment chains (CDN -> LB -> ingress).
const MAX_PROXY_HOPS = 10

const trustProxyCoercion = z
  .string()
  .default("false")
  .transform((val, ctx): boolean | number | string => {
    if (val === "true") return true
    if (val === "false" || val === "") return false
    if (/^\d+$/.test(val)) {
      // A hop count, not a subnet/preset. Bounded: an oversized value (or
      // one parseInt rounds to Infinity) would trust every X-Forwarded-For
      // hop, letting clients spoof their IP past the rate limits.
      const hops = Number(val)
      if (hops > MAX_PROXY_HOPS) {
        ctx.addIssue({
          code: "custom",
          message: `HTTP_TRUST_PROXY hop count must be between 0 and ${MAX_PROXY_HOPS}, got "${val}"`,
        })
        return z.NEVER
      }
      return hops
    }
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
    HTTP_PORT: intFromEnv("HTTP_PORT", "3000", 1, 65535),
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
    HTTP_SESSION_TIMEOUT_MS: intFromEnv("HTTP_SESSION_TIMEOUT_MS", "3600000", 0, MAX_TIMER_MS),
    CACHE_TTL_MS: intFromEnv("CACHE_TTL_MS", "60000", 1, MAX_TIMER_MS),
    // Must be positive: Postgres treats statement_timeout=0 as "no limit",
    // which would let one pathological query pin a pool connection forever.
    DB_STATEMENT_TIMEOUT_MS: intFromEnv("DB_STATEMENT_TIMEOUT_MS", "10000", 1, MAX_TIMER_MS),
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
