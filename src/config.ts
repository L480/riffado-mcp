import { z } from "zod"
import os from "os"
import path from "path"
import dotenv from "dotenv"

dotenv.config()

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

const configSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY must be exactly 64 hex characters"),
  RIFFADO_USER_ID: z.string().optional(),
  RIFFADO_APP_URL: z.string().refine(isValidUrl, "RIFFADO_APP_URL must be a valid URL").optional(),
  TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  HTTP_PORT: z
    .string()
    .default("3000")
    .transform((val) => parseInt(val, 10)),
  HTTP_HOST: z.string().default("localhost"),
  HTTP_AUTH_TOKEN: z.string().optional(),
  HTTP_AUTH_HEADER_NAME: z.string().default("x-mcp-token"),
  HTTP_OAUTH_ENABLED: boolFromString("true"),
  HTTP_PUBLIC_URL: z.string().refine(isValidUrl, "HTTP_PUBLIC_URL must be a valid URL").optional(),
  HTTP_OAUTH_STATE_FILE: z.string().default(defaultOAuthStateFile),
  HTTP_TRUST_PROXY: trustProxyCoercion,
  HTTP_SESSION_TIMEOUT_MS: z
    .string()
    .default("0")
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

export type Config = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env)
}

export const config = loadConfig()
