import path from "node:path"
import { parse as parseYaml } from "yaml"

export interface ContextInfo {
  name: string
  cluster?: string
  user?: string
  namespace?: string
}

export interface ParsedKubeconfig {
  contexts: ContextInfo[]
  currentContext?: string
  valid: boolean
  error?: string
}

export type SourceKind = "file" | "dir" | "secret-store"

export interface DiscoveredSource {
  /** Selection identity: the config id for file/secret-store, `dir:<configId>:<file>` for dir entries. */
  id: string
  label: string
  kind: SourceKind
  /** Config source that produced this entry. */
  configId: string
  /** Absolute path of the kubeconfig file, when it lives on disk. */
  path?: string
  /** Secret store entry name, for secret-store sources. */
  entry?: string
  /** File name inside a directory source. */
  fileName?: string
  available: boolean
  contexts: ContextInfo[]
  currentContext?: string
  error?: string
  /** True when a directory source has no files and stands in for the whole directory. */
  group?: boolean
}

export interface ContextView extends ContextInfo {
  /** First enabled source that defines this context name. */
  source: string
  sourceLabel: string
  /** Other enabled sources that define the same name; the first one wins. */
  alsoIn: string[]
}

type Record = { [key: string]: unknown }

function isRecord(value: unknown): value is Record {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function looksLikeConfig(doc: Record): boolean {
  return "contexts" in doc || "clusters" in doc || "users" in doc || "current-context" in doc || doc.kind === "Config"
}

export function parseKubeconfig(text: string, label: string): ParsedKubeconfig {
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (error) {
    return { contexts: [], valid: false, error: `${label} is not valid YAML: ${messageOf(error)}` }
  }

  if (!isRecord(doc) || !looksLikeConfig(doc)) {
    return { contexts: [], valid: false, error: `${label} is not a kubeconfig (no contexts, clusters or current-context)` }
  }

  if (doc["contexts"] != null && !Array.isArray(doc["contexts"])) {
    return { contexts: [], valid: false, error: `${label} has an invalid contexts field` }
  }

  const seen = new Set<string>()
  const contexts: ContextInfo[] = []
  for (const item of (doc["contexts"] as unknown[]) ?? []) {
    if (!isRecord(item)) continue
    const name = stringField(item.name)
    if (!name || seen.has(name)) continue
    seen.add(name)
    const detail = isRecord(item.context) ? item.context : {}
    const context: ContextInfo = { name }
    const cluster = stringField(detail.cluster)
    const user = stringField(detail.user)
    const namespace = stringField(detail.namespace)
    if (cluster) context.cluster = cluster
    if (user) context.user = user
    if (namespace) context.namespace = namespace
    contexts.push(context)
  }

  return {
    contexts,
    currentContext: stringField(doc["current-context"]),
    valid: true,
  }
}

/** Write the smallest possible kubeconfig that only selects a context. */
export function selectorYaml(context: string): string {
  return `apiVersion: v1\nkind: Config\ncurrent-context: ${JSON.stringify(context)}\n`
}

export function kubeconfigValue(paths: readonly string[]): string {
  return paths.filter(Boolean).join(path.delimiter)
}

export function shortContext(context: string, limit = 28): string {
  if (context.length <= limit) return context
  return `${context.slice(0, Math.max(1, limit - 1))}…`
}

/**
 * A secret store entry holds either raw kubeconfig YAML or its base64 encoding.
 * Base64 is the documented form because the store holds one `NAME=value` line
 * per entry.
 */
export function decodeKubeconfigValue(value: string, entry: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`Secret store entry ${entry} is empty`)

  if (/^(apiVersion|clusters|contexts|kind|users)\s*:/m.test(trimmed)) return trimmed

  const payload = trimmed.startsWith("base64:") ? trimmed.slice(7).replace(/\s+/g, "") : trimmed.replace(/\s+/g, "")
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(payload)) {
    throw new Error(`Secret store entry ${entry} is neither kubeconfig YAML nor base64`)
  }

  const decoded = Buffer.from(payload, "base64").toString("utf8")
  if (/^(apiVersion|clusters|contexts|kind|users)\s*:/m.test(decoded)) return decoded
  throw new Error(`Secret store entry ${entry} does not decode to a kubeconfig`)
}

export interface SourceView {
  id: string
  label: string
  kind: SourceKind
  configId: string
  path?: string
  entry?: string
  fileName?: string
  available: boolean
  enabled: boolean
  contexts: ContextInfo[]
  currentContext?: string
  error?: string
  /** A config-level dir source that produced several files. */
  group?: boolean
}

export interface ContextSelection {
  contexts: ContextView[]
  currentContext?: string
  currentSource?: string
  currentSourceLabel?: string
}

/**
 * Merge enabled sources in order. First file wins for duplicate context names,
 * matching client-go's merge rules.
 */
export function buildContextView(
  sources: readonly DiscoveredSource[],
  enabled: ReadonlySet<string>,
  selected?: string,
): ContextSelection {
  const byName = new Map<string, ContextView>()
  const order: ContextView[] = []
  let currentContext: string | undefined
  let currentSource: string | undefined
  let currentSourceLabel: string | undefined

  for (const source of sources) {
    if (!enabled.has(source.id) || !source.available) continue

    if (!currentContext && source.currentContext) {
      currentContext = source.currentContext
      currentSource = source.id
      currentSourceLabel = source.label
    }

    for (const context of source.contexts) {
      const existing = byName.get(context.name)
      if (existing) {
        existing.alsoIn.push(source.id)
        continue
      }
      const view: ContextView = {
        ...context,
        source: source.id,
        sourceLabel: source.label,
        alsoIn: [],
      }
      byName.set(context.name, view)
      order.push(view)
    }
  }

  if (selected) {
    const match = byName.get(selected)
    if (match) {
      currentContext = match.name
      currentSource = match.source
      currentSourceLabel = match.sourceLabel
    }
  }

  return { contexts: order, currentContext, currentSource, currentSourceLabel }
}

export function expandSelection(requested: readonly string[], sources: readonly DiscoveredSource[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const has = (id: string) => sources.some((source) => source.id === id)

  for (const id of requested) {
    const matches = has(id)
      ? sources.filter((source) => source.id === id)
      : sources.filter((source) => source.configId === id && source.id !== id)
    for (const source of matches) {
      if (seen.has(source.id)) continue
      seen.add(source.id)
      result.push(source.id)
    }
  }

  // Keep discovery order so the merge order is predictable.
  return sources.filter((source) => seen.has(source.id)).map((source) => source.id)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
