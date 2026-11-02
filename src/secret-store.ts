import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import type { Config } from "./config.js"
import { expandPath, messageOf } from "./util.js"

const run = promisify(execFile)

/**
 * Provider ids. `local-age` is the built-in provider: an age-encrypted file on
 * disk, decrypted with the age CLI. `custom` runs the layer's `provider` argv
 * template. A future Hashicorp Vault provider would be a third id here.
 */
export type SecretProviderType = "local-age" | "custom"

export const LOCAL_AGE: SecretProviderType = "local-age"
export const CUSTOM_PROVIDER: SecretProviderType = "custom"
export const LOCAL_AGE_PROVIDER = ["age", "--decrypt", "--identity", "{keyFile}", "{store}"]
export const DEFAULT_TTL_SECONDS = 60
export const DEFAULT_TIMEOUT_MS = 15_000

const ENTRY_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/

export interface SecretLayer {
  /** Provider technology: `local-age` (default) or `custom` (explicit argv). */
  type: SecretProviderType
  /** argv template; `{store}`, `{keyFile}` and `{cwd}` are substituted. Empty uses age. */
  provider: string[]
  /** Encrypted store file, absolute, home-relative or work-directory relative. */
  store?: string
  /** Private key / identity file for the default local-age provider. */
  keyFile?: string
}

export interface SecretStoreSource {
  layers: SecretLayer[]
  ttlSeconds: number
  warnings: string[]
}

export interface SecretEntryValue {
  value: string
  layer: string
}

export interface SecretListing {
  entries: string[]
  layers: string[]
  warnings: string[]
  errors: string[]
}

type JsonRecord = { [key: string]: unknown }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resolveType(value: unknown, hasProvider: boolean): SecretProviderType {
  // An explicit argv provider is always a custom provider. Otherwise a known
  // `type` is honoured and anything else falls back to the built-in.
  if (hasProvider) return CUSTOM_PROVIDER
  if (typeof value === "string" && value.trim() === CUSTOM_PROVIDER) return CUSTOM_PROVIDER
  return LOCAL_AGE
}

export function normalizeLayer(value: unknown): SecretLayer | undefined {
  if (!isRecord(value)) return undefined
  const provider = Array.isArray(value.provider)
    ? value.provider
        .filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item: string) => item.trim())
    : []
  const store = typeof value.store === "string" && value.store.trim() ? value.store.trim() : undefined
  const keyFile = typeof value.keyFile === "string" && value.keyFile.trim() ? value.keyFile.trim() : undefined
  if (!store && !provider.length) return undefined
  return { type: resolveType(value.type, provider.length > 0), provider, store, keyFile }
}

function normalizeLayers(value: unknown): SecretLayer[] {
  if (!isRecord(value)) return []
  if (Array.isArray(value.stores)) {
    return value.stores.map(normalizeLayer).filter((layer): layer is SecretLayer => Boolean(layer))
  }
  const single = normalizeLayer(value)
  return single ? [single] : []
}

export function globalEnvManagerPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "env-manager.json")
}

/**
 * Layered secret store configuration inherited from env-manager: project first,
 * then global. `secretStore` is the current key; `vault` is the pre-rename one.
 */
export async function envManagerLayers(directory: string): Promise<{ layers: SecretLayer[]; warnings: string[] }> {
  const warnings: string[] = []
  const layers: SecretLayer[] = []

  const read = async (file: string): Promise<SecretLayer[]> => {
    try {
      const text = await fs.readFile(file, "utf8")
      const parsed = JSON.parse(text.replace(/^\uFEFF/, ""))
      if (!isRecord(parsed)) return []
      return normalizeLayers(parsed.secretStore ?? parsed.vault)
    } catch (error: any) {
      if (error?.code !== "ENOENT") warnings.push(`Cannot read env-manager secret store config ${file}: ${messageOf(error)}`)
      return []
    }
  }

  layers.push(...(await read(path.join(directory, ".opencode", "env-profiles.json"))))
  layers.push(...(await read(globalEnvManagerPath())))

  const seen = new Set<string>()
  const unique = layers.filter((layer) => {
    const key = `${layer.type}\u0000${layer.provider.join("\u0000")}|${layer.store ?? ""}|${layer.keyFile ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return { layers: unique, warnings }
}

export async function secretStoreSource(directory: string, config: Config): Promise<SecretStoreSource> {
  if (config.secretStore.stores.length) {
    return { layers: config.secretStore.stores, ttlSeconds: config.secretStore.ttlSeconds, warnings: [] }
  }
  if (!config.secretStore.inherit) {
    return { layers: [], ttlSeconds: config.secretStore.ttlSeconds, warnings: [] }
  }
  const inherited = await envManagerLayers(directory)
  return { layers: inherited.layers, ttlSeconds: config.secretStore.ttlSeconds, warnings: inherited.warnings }
}

function storeArgument(layer: SecretLayer, directory: string): string {
  const store = layer.store ?? ""
  if (!layer.provider.length) return expandPath(store, directory)
  if (store.startsWith("~") || store.startsWith("$HOME/") || path.isAbsolute(store)) return expandPath(store, directory)
  return store
}

export function layerArgv(layer: SecretLayer, directory: string): string[] {
  if (!layer.store && !layer.provider.length) throw new Error("Secret store layer has neither a store nor a provider")
  const store = storeArgument(layer, directory)
  const keyFile = layer.keyFile ? expandPath(layer.keyFile, directory) : undefined
  const template = layer.provider.length ? layer.provider : LOCAL_AGE_PROVIDER
  if (!layer.provider.length && !keyFile) {
    throw new Error("The local-age provider needs keyFile on the layer, or an explicit provider")
  }
  return template.map((token) =>
    token.replaceAll("{store}", store).replaceAll("{keyFile}", keyFile ?? "").replaceAll("{cwd}", directory),
  )
}

export function describeLayer(layer: SecretLayer, directory: string): string {
  if (layer.provider.length) {
    try {
      return layerArgv(layer, directory).join(" ")
    } catch {
      return layer.provider.join(" ")
    }
  }
  return storeArgument(layer, directory) || LOCAL_AGE_PROVIDER.join(" ")
}

export function isValidEntryName(name: string): boolean {
  return ENTRY_NAME.test(name)
}

/**
 * Parse a decrypted secret store file. Values are taken literally: `$VAR` is
 * never expanded, because credentials routinely contain `$` and backslashes.
 */
export function parseSecretFile(text: string): { values: Record<string, string>; warnings: string[] } {
  const values: Record<string, string> = {}
  const warnings: string[] = []
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/)

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1
    let line = lines[index]!.trim()
    if (!line || line.startsWith("#")) continue
    line = line.replace(/^export\s+/i, "").trim()

    const equals = line.indexOf("=")
    if (equals <= 0) {
      warnings.push(`line ${lineNumber}: expected NAME=value`)
      continue
    }
    const key = line.slice(0, equals).trim()
    if (!ENTRY_NAME.test(key)) {
      warnings.push(`line ${lineNumber}: invalid entry name "${key}"`)
      continue
    }
    values[key] = parseLiteralValue(line.slice(equals + 1).trimStart())
  }

  return { values, warnings }
}

function parseLiteralValue(raw: string): string {
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1)
    return end === -1 ? raw.slice(1) : raw.slice(1, end)
  }
  if (raw.startsWith('"')) {
    let value = ""
    for (let index = 1; index < raw.length; index++) {
      const character = raw[index]!
      if (character === "\\") {
        const next = raw[++index]
        if (next === undefined) break
        value += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next
      } else if (character === '"') {
        return value
      } else {
        value += character
      }
    }
    return value
  }
  return raw.trimEnd()
}

interface Decrypted {
  at: number
  values: Record<string, string>
  warnings: string[]
}

export class SecretStore {
  private readonly cache = new Map<string, Decrypted>()

  constructor(
    private readonly directory: string,
    private readonly load: () => Promise<SecretStoreSource>,
  ) {}

  invalidate(): void {
    this.cache.clear()
  }

  private async decryptLayer(layer: SecretLayer, ttl: number, force = false): Promise<Decrypted> {
    const key = describeLayer(layer, this.directory)
    const cached = this.cache.get(key)
    if (!force && ttl > 0 && cached && Date.now() - cached.at < ttl) return cached

    const argv = layerArgv(layer, this.directory)
    const [file, ...args] = argv as [string, ...string[]]

    let stdout: string
    try {
      const result = (await run(file, args, {
        cwd: this.directory,
        env: childEnvironment(),
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      } as any)) as unknown as { stdout: string }
      stdout = String(result.stdout ?? "")
    } catch (error) {
      throw new Error(runErrorMessage(file, error))
    }

    const parsed = parseSecretFile(stdout)
    const entry: Decrypted = { at: Date.now(), values: parsed.values, warnings: parsed.warnings }
    this.cache.set(key, entry)
    return entry
  }

  /** Resolve one secret store entry across the layered stores. Values stay in memory. */
  async entry(name: string): Promise<SecretEntryValue | undefined> {
    const source = await this.load()
    for (const layer of source.layers) {
      let decrypted: Decrypted
      try {
        decrypted = await this.decryptLayer(layer, source.ttlSeconds)
      } catch {
        continue
      }
      const value = decrypted.values[name]
      if (value !== undefined) return { value, layer: describeLayer(layer, this.directory) }
    }
    return undefined
  }

  async list(): Promise<SecretListing> {
    const source = await this.load()
    const listing: SecretListing = { entries: [], layers: [], warnings: [...source.warnings], errors: [] }
    const merged = new Set<string>()

    for (const layer of source.layers) {
      const description = describeLayer(layer, this.directory)
      try {
        const decrypted = await this.decryptLayer(layer, source.ttlSeconds)
        listing.layers.push(description)
        for (const name of Object.keys(decrypted.values)) merged.add(name)
        listing.warnings.push(...decrypted.warnings)
      } catch (error) {
        listing.errors.push(`${description}: ${messageOf(error)}`)
      }
    }

    listing.entries = [...merged].sort()
    return listing
  }
}

export function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: os.homedir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: os.tmpdir(),
  }
  if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK
  return env
}

function runErrorMessage(file: string, error: any): string {
  if (error?.code === "ENOENT") {
    return `Secret store command not found: ${file}. Install it (for local-age: sudo apt install age) or set the layer provider.`
  }
  if (error?.killed || error?.signal === "SIGTERM") {
    return `Secret store command timed out after ${DEFAULT_TIMEOUT_MS / 1000}s: ${file}`
  }
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : ""
  return `Secret store command failed (${file}): ${stderr || messageOf(error)}`
}
