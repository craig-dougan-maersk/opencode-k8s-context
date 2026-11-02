import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { expandPath, messageOf } from "./util.js"
import { normalizeLayer, type SecretLayer } from "./secret-store.js"

export { expandPath, messageOf }

export const PROJECT_CONFIG = "k8s-contexts.json"
export const GLOBAL_CONFIG = "k8s-manager.json"
export const SOURCE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/

export interface SourceConfig {
  /** Stable identifier used by selections, profile links and storage. */
  id: string
  kind: "file" | "dir" | "secret-store"
  /** Human name shown in the status bar and menus. */
  label?: string
  /** File or directory path for `file` and `dir` sources. */
  path?: string
  /** Secret store entry name for `secret-store` sources. */
  entry?: string
}

export interface Config {
  version: 1
  sources: SourceConfig[]
  defaultEnabled: string[]
  profileLinks: Record<string, string[]>
  secretStore: {
    /** Read layers from env-manager's config when no explicit stores are set. */
    inherit: boolean
    stores: SecretLayer[]
    ttlSeconds: number
  }
}

export interface LoadedConfig {
  config: Config
  path: string
  exists: boolean
  warnings: string[]
}

export function defaultConfig(): Config {
  return {
    version: 1,
    sources: [
      { id: "default", kind: "file", path: "~/.kube/config", label: "default" },
      { id: "kubeconfigs", kind: "dir", path: "~/.kube/configs", label: "kubeconfigs" },
    ],
    defaultEnabled: ["default"],
    profileLinks: {},
    secretStore: { inherit: true, stores: [], ttlSeconds: 60 },
  }
}

export function projectConfigPath(directory: string): string {
  return path.join(directory, ".opencode", PROJECT_CONFIG)
}

export function globalConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", GLOBAL_CONFIG)
}

export function isSourceId(value: string): boolean {
  return SOURCE_ID.test(value) && value.length <= 120
}

type JsonRecord = { [key: string]: unknown }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []
}

function normalizeSource(value: unknown, warnings: string[]): SourceConfig | undefined {
  if (!isRecord(value)) return undefined
  const id = typeof value.id === "string" ? value.id.trim() : ""
  // `secret-store` is current; `vault` is the pre-rename value, accepted and
  // normalised so an existing config keeps working.
  const kind = value.kind === "vault" ? "secret-store" : value.kind
  if (!id || !isSourceId(id)) {
    warnings.push(`Ignoring source with an invalid id: ${JSON.stringify(value.id)}`)
    return undefined
  }
  if (kind !== "file" && kind !== "dir" && kind !== "secret-store") {
    warnings.push(`Ignoring source "${id}": kind must be file, dir or secret-store`)
    return undefined
  }
  const source: SourceConfig = { id, kind }
  if (typeof value.label === "string" && value.label.trim()) source.label = value.label.trim()
  if (typeof value.path === "string" && value.path.trim()) source.path = value.path.trim()
  if (typeof value.entry === "string" && value.entry.trim()) source.entry = value.entry.trim()

  if (kind === "secret-store" && !source.entry) {
    warnings.push(`Ignoring source "${id}": secret-store sources need an entry`)
    return undefined
  }
  if (kind !== "secret-store" && !source.path) {
    warnings.push(`Ignoring source "${id}": ${kind} sources need a path`)
    return undefined
  }
  return source
}

function normalizeSecretStore(value: unknown): Config["secretStore"] {
  if (!isRecord(value)) return { inherit: true, stores: [], ttlSeconds: 60 }
  const stores: SecretLayer[] = []
  if (Array.isArray(value.stores)) {
    for (const item of value.stores) {
      const layer = normalizeLayer(item)
      if (layer) stores.push(layer)
    }
  }
  const ttlSeconds =
    typeof value.ttlSeconds === "number" && Number.isFinite(value.ttlSeconds) && value.ttlSeconds >= 0
      ? Math.min(Math.floor(value.ttlSeconds), 3600)
      : 60
  return { inherit: value.inherit !== false, stores, ttlSeconds }
}

export function normalizeConfig(value: unknown, warnings: string[] = []): Config {
  const base = defaultConfig()
  if (!isRecord(value)) return base

  const config: Config = {
    version: 1,
    sources: [],
    defaultEnabled: [],
    profileLinks: {},
    // `secretStore` is current; `vault` is the pre-rename key.
    secretStore: normalizeSecretStore(value.secretStore ?? value.vault),
  }

  if (Array.isArray(value.sources)) {
    for (const item of value.sources) {
      const source = normalizeSource(item, warnings)
      if (source) config.sources.push(source)
    }
  }

  config.defaultEnabled = strings(value.defaultEnabled)
  if (!config.defaultEnabled.length && !Array.isArray(value.defaultEnabled) && value.defaultEnabled === undefined) {
    config.defaultEnabled = [...base.defaultEnabled]
  }

  if (isRecord(value.profileLinks)) {
    for (const [profile, ids] of Object.entries(value.profileLinks)) {
      const list = strings(ids)
      if (list.length) config.profileLinks[profile] = list
    }
  }

  return config
}

function mergeConfigs(global: Config, project: Config | undefined): Config {
  const sources = new Map<string, SourceConfig>()
  for (const source of global.sources) sources.set(source.id, source)
  for (const source of project?.sources ?? []) sources.set(source.id, source)

  return {
    version: 1,
    sources: [...sources.values()],
    defaultEnabled: project?.defaultEnabled.length ? project.defaultEnabled : global.defaultEnabled,
    profileLinks: { ...global.profileLinks, ...(project?.profileLinks ?? {}) },
    secretStore: {
      inherit: (project?.secretStore.inherit ?? true) && global.secretStore.inherit,
      stores: project?.secretStore.stores.length ? project.secretStore.stores : global.secretStore.stores,
      ttlSeconds: project?.secretStore.ttlSeconds ?? global.secretStore.ttlSeconds,
    },
  }
}

async function readConfigFile(file: string, warnings: string[]): Promise<Config | undefined> {
  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined
    warnings.push(`Cannot read ${file}: ${messageOf(error)}`)
    return undefined
  }
  try {
    return normalizeConfig(JSON.parse(text.replace(/^\uFEFF/, "")), warnings)
  } catch (error) {
    warnings.push(`Cannot parse ${file}: ${messageOf(error)}`)
    return undefined
  }
}

export async function loadConfig(directory: string): Promise<LoadedConfig> {
  const warnings: string[] = []
  const projectPath = projectConfigPath(directory)
  const globalPath = globalConfigPath()

  const [project, global] = await Promise.all([
    readConfigFile(projectPath, warnings),
    readConfigFile(globalPath, warnings),
  ])

  if (!project && !global) {
    const config = defaultConfig()
    return { config, path: projectPath, exists: false, warnings }
  }

  const config = mergeConfigs(global ?? defaultConfig(), project)
  return {
    config,
    path: project ? projectPath : globalPath,
    exists: Boolean(project || global),
    warnings,
  }
}

export async function ensureConfig(directory: string): Promise<LoadedConfig> {
  const loaded = await loadConfig(directory)
  if (loaded.exists) return loaded
  await saveConfig(directory, loaded.config)
  return { ...loaded, path: projectConfigPath(directory), exists: true }
}

export async function saveConfig(directory: string, config: Config): Promise<void> {
  const file = projectConfigPath(directory)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  await fs.chmod(file, 0o600).catch(() => undefined)
}

export function sourceLabel(source: SourceConfig): string {
  if (source.label) return source.label
  if (source.kind === "secret-store") return source.entry ?? source.id
  if (source.path) return path.basename(source.path) || source.path
  return source.id
}
