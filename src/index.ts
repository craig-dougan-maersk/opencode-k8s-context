import { execFile } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import { Plugin } from "@opencode/plugin"

import {
  ensureConfig,
  loadConfig,
  messageOf,
  projectConfigPath,
  saveConfig,
  sourceLabel,
  type Config,
  type LoadedConfig,
  type SourceConfig,
} from "./config.js"
import {
  buildContextView,
  decodeKubeconfigValue,
  expandSelection,
  kubeconfigValue,
  parseKubeconfig,
  selectorYaml,
  type ContextView,
  type DiscoveredSource,
  type ParsedKubeconfig,
  type SourceView,
} from "./kubeconfig.js"
import { K8s } from "./rpc.js"
import {
  expandPath,
  isDirectory,
  isFile,
  safeName,
  stateDirectory,
  writePrivateFile,
} from "./util.js"
import { SecretStore, secretStoreSource, type SecretListing } from "./secret-store.js"

const run = promisify(execFile)
const DISCOVERY_TTL_MS = 5_000
const GRANT_TTL_MS = 30_000

interface Runtime {
  enabled?: string[]
  context?: string
  profile?: string
  touched?: boolean
}

interface Active {
  kubeconfig?: string
  context?: string
  cleared: boolean
}

interface Discovery {
  at: number
  sources: DiscoveredSource[]
  warnings: string[]
  files: Set<string>
}

interface StateView {
  directory: string
  configPath: string
  sessionID: string | null
  profile?: string
  touched: boolean
  sources: SourceView[]
  configSources: Array<{ id: string; kind: string; label: string }>
  contexts: ContextView[]
  enabled: string[]
  context?: string
  contextSource?: string
  contextSourceLabel?: string
  kubeconfig?: string
  defaultEnabled: string[]
  profileLinks: Record<string, string[]>
  warnings: string[]
  secretStore: { configured: boolean; layers: number; warnings: string[] }
}

interface BuildOptions {
  track?: boolean
  refresh?: boolean
}

export default Plugin.define({
  id: "k8s.manager",
  async setup(ctx) {
    const directory = ctx.location.directory
    const stateDir = stateDirectory()
    const selectorDir = path.join(stateDir, "sessions")
    const secretStoreDir = path.join(stateDir, "secret-store")

    const live = new Map<string, Runtime>()
    const written = new Map<string, string>()
    let discovery: Discovery | undefined
    let locationSelection: Active | undefined
    let registration: any

    let queue: Promise<unknown> = Promise.resolve()
    function serial<T>(operation: () => Promise<T>): Promise<T> {
      const run = queue.then(operation, operation)
      queue = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }

    const secretStore = new SecretStore(directory, async () => {
      const loaded = await loadConfig(directory)
      return secretStoreSource(directory, loaded.config)
    })

    function storageKey(sessionID: string): string {
      return `session:${directory}:${sessionID}`
    }

    function locationKey(): string {
      return `location:${directory}`
    }

    function grantedKey(command: string): string {
      return `${directory}\u0000${command}`
    }

    async function runtimeFor(sessionID: string | undefined, seen = new Set<string>()): Promise<Runtime> {
      if (!sessionID) return {}
      const existing = live.get(sessionID)
      if (existing) return existing
      if (seen.has(sessionID)) return {}
      seen.add(sessionID)

      let stored: Runtime | undefined
      try {
        const value = (await ctx.storage.get(storageKey(sessionID))) as Runtime | undefined
        if (value && typeof value === "object") stored = value
      } catch {
        // Restoring a selection is an optimisation; ignore storage failures.
      }

      let parent: Runtime | undefined
      try {
        const session = await ctx.session.get({ sessionID })
        if (session?.parentID) parent = await runtimeFor(session.parentID, seen)
      } catch {
        // A session that is not visible yet simply has no parent state.
      }

      const runtime: Runtime = stored ?? {
        enabled: parent?.enabled ? [...parent.enabled] : undefined,
        context: parent?.context,
        profile: parent?.profile,
        touched: parent?.touched,
      }
      live.set(sessionID, runtime)
      return runtime
    }

    async function persist(sessionID: string | undefined, runtime: Runtime): Promise<void> {
      if (!sessionID) return
      try {
        await ctx.storage.set(storageKey(sessionID), runtime as any)
      } catch {
        // Selection still works for this process; persistence is best effort.
      }
    }

    async function currentConfig(): Promise<LoadedConfig> {
      const loaded = await loadConfig(directory)
      return loaded
    }

    // ---- discovery ---------------------------------------------------------

    async function readKubeconfigFile(file: string, label: string): Promise<ParsedKubeconfig> {
      try {
        const stat = await fs.stat(file)
        if (!stat.isFile()) return { valid: false, contexts: [], error: `${label} is not a file` }
        if (stat.size > 8 * 1024 * 1024) return { valid: false, contexts: [], error: `${label} is larger than 8 MiB` }
        const text = await fs.readFile(file, "utf8")
        return parseKubeconfig(text, label)
      } catch (error: any) {
        if (error?.code === "ENOENT") return { valid: false, contexts: [], error: `${label} does not exist` }
        return { valid: false, contexts: [], error: `${label}: ${messageOf(error)}` }
      }
    }

    async function discover(config: Config, force = false): Promise<Discovery> {
      if (!force && discovery && Date.now() - discovery.at < DISCOVERY_TTL_MS) return discovery

      const sources: DiscoveredSource[] = []
      const warnings: string[] = []
      const files = new Set<string>()

      for (const source of config.sources) {
        if (source.kind === "file") {
          const file = expandPath(source.path ?? "", directory)
          const parsed = await readKubeconfigFile(file, sourceLabel(source))
          sources.push({
            id: source.id,
            label: sourceLabel(source),
            kind: "file",
            configId: source.id,
            path: file,
            fileName: path.basename(file),
            available: parsed.valid,
            contexts: parsed.contexts,
            currentContext: parsed.currentContext,
            error: parsed.error,
          })
          files.add(file)
          if (!parsed.valid && parsed.error) warnings.push(parsed.error)
          continue
        }

        if (source.kind === "dir") {
          const dir = expandPath(source.path ?? "", directory)
          if (!(await isDirectory(dir))) {
            sources.push({
              id: source.id,
              label: sourceLabel(source),
              kind: "dir",
              configId: source.id,
              path: dir,
              available: false,
              contexts: [],
              error: `Directory not found: ${dir}`,
              group: true,
            })
            warnings.push(`Source "${sourceLabel(source)}": directory not found: ${dir}`)
            continue
          }

          let names: string[] = []
          try {
            names = (await fs.readdir(dir)).filter((name) => !name.startsWith(".")).sort()
          } catch (error) {
            warnings.push(`Cannot read ${dir}: ${messageOf(error)}`)
          }

          let found = 0
          for (const name of names) {
            const file = path.join(dir, name)
            let stat
            try {
              stat = await fs.stat(file)
            } catch {
              continue
            }
            if (!stat.isFile()) continue
            found++
            const parsed = await readKubeconfigFile(file, name)
            sources.push({
              id: `dir:${source.id}:${name}`,
              label: `${sourceLabel(source)}/${name}`,
              kind: "dir",
              configId: source.id,
              path: file,
              fileName: name,
              available: parsed.valid,
              contexts: parsed.contexts,
              currentContext: parsed.currentContext,
              error: parsed.error,
            })
            files.add(file)
            if (!parsed.valid && parsed.error) warnings.push(parsed.error)
          }

          if (!found) {
            sources.push({
              id: source.id,
              label: sourceLabel(source),
              kind: "dir",
              configId: source.id,
              path: dir,
              available: false,
              contexts: [],
              error: `No kubeconfig files in ${dir}`,
              group: true,
            })
            warnings.push(`Source "${sourceLabel(source)}": no kubeconfig files in ${dir}`)
          }
          continue
        }

        // Secret-store-backed kubeconfig.
        const entry = source.entry ?? ""
        let text: string | undefined
        try {
          const found = await secretStore.entry(entry)
          if (!found) throw new Error(`Secret store entry not found: ${entry}`)
          text = decodeKubeconfigValue(found.value, entry)
        } catch (error) {
          sources.push({
            id: source.id,
            label: sourceLabel(source),
            kind: "secret-store",
            configId: source.id,
            entry,
            available: false,
            contexts: [],
            error: messageOf(error),
          })
          warnings.push(`Source "${sourceLabel(source)}": ${messageOf(error)}`)
          continue
        }

        const hash = crypto.createHash("sha1").update(`${entry}\u0000${text}`).digest("hex").slice(0, 16)
        const file = path.join(secretStoreDir, `${safeName(entry)}-${hash}.yaml`)
        try {
          if (!(await isFile(file))) await writePrivateFile(file, text)
        } catch (error) {
          warnings.push(`Cannot write temporary kubeconfig for ${entry}: ${messageOf(error)}`)
        }
        files.add(file)
        const parsed = parseKubeconfig(text, sourceLabel(source))
        sources.push({
          id: source.id,
          label: sourceLabel(source),
          kind: "secret-store",
          configId: source.id,
          path: file,
          entry,
          available: parsed.valid,
          contexts: parsed.contexts,
          currentContext: parsed.currentContext,
          error: parsed.error,
        })
        if (!parsed.valid && parsed.error) warnings.push(parsed.error)
      }

      // Remove decrypted copies that no longer belong to a configured source.
      try {
        for (const name of await fs.readdir(secretStoreDir)) {
          const file = path.join(secretStoreDir, name)
          if (!files.has(file)) await fs.rm(file, { force: true })
        }
      } catch {
        // The directory may not exist yet.
      }

      // Pre-rename builds wrote decrypted kubeconfigs under a `vault` directory.
      // Remove it so no decrypted copy is left behind.
      await fs.rm(path.join(stateDir, "vault"), { recursive: true, force: true }).catch(() => undefined)

      discovery = { at: Date.now(), sources, warnings, files }
      return discovery
    }

    function resolveEnabled(config: Config, runtime: Runtime, sources: DiscoveredSource[]): string[] {
      let requested: string[]
      if (runtime.enabled) {
        requested = runtime.enabled
      } else {
        const links = runtime.profile ? config.profileLinks[runtime.profile] : undefined
        requested = links?.length ? links : config.defaultEnabled
      }
      return expandSelection(requested, sources)
    }

    // ---- state -------------------------------------------------------------

    async function selectorPath(sessionID: string | undefined, context: string): Promise<string> {
      const key = sessionID ?? `location-${crypto.createHash("sha1").update(directory).digest("hex").slice(0, 10)}`
      const file = path.join(selectorDir, `${safeName(key)}.yaml`)
      if (written.get(file) !== context) {
        await writePrivateFile(file, selectorYaml(context))
        written.set(file, context)
      }
      return file
    }

    async function buildState(sessionID: string | undefined, options: BuildOptions = {}): Promise<StateView> {
      const loaded = await currentConfig()
      const config = loaded.config
      const found = await discover(config, options.refresh === true)
      const runtime = await runtimeFor(sessionID)
      const enabled = resolveEnabled(config, runtime, found.sources)
      const enabledSet = new Set(enabled)
      const view = buildContextView(found.sources, enabledSet, runtime.context)

      const warnings = [...loaded.warnings, ...found.warnings]
      if (runtime.context && !view.contexts.some((item) => item.name === runtime.context)) {
        warnings.push(`Selected context "${runtime.context}" is no longer available in the enabled kubeconfigs`)
      }

      const enabledPaths = found.sources.filter((source) => enabledSet.has(source.id)).map((source) => source.path)
      const paths = enabledPaths.filter((item): item is string => Boolean(item))
      let kubeconfig: string | undefined

      if (view.currentContext) {
        const selector = await selectorPath(sessionID, view.currentContext)
        kubeconfig = kubeconfigValue([selector, ...paths])
      } else if (paths.length) {
        kubeconfig = kubeconfigValue(paths)
      }

      const sources: SourceView[] = found.sources.map((source) => ({
        id: source.id,
        label: source.label,
        kind: source.kind,
        configId: source.configId,
        path: source.path,
        entry: source.entry,
        fileName: source.fileName,
        available: source.available,
        enabled: enabledSet.has(source.id),
        contexts: source.contexts,
        currentContext: source.currentContext,
        error: source.error,
        group: source.group,
      }))

      const secretStoreInfo = await secretStoreSource(directory, config)

      const state: StateView = {
        directory,
        configPath: projectConfigPath(directory),
        sessionID: sessionID ?? null,
        profile: runtime.profile,
        touched: runtime.touched === true || runtime.enabled !== undefined,
        sources,
        configSources: config.sources.map((source) => ({
          id: source.id,
          kind: source.kind,
          label: sourceLabel(source),
        })),
        contexts: view.contexts,
        enabled,
        context: view.currentContext,
        contextSource: view.currentSource,
        contextSourceLabel: view.currentSourceLabel,
        kubeconfig,
        defaultEnabled: config.defaultEnabled,
        profileLinks: config.profileLinks,
        warnings,
        secretStore: {
          configured: secretStoreInfo.layers.length > 0,
          layers: secretStoreInfo.layers.length,
          warnings: secretStoreInfo.warnings,
        },
      }

      if (options.track) {
        locationSelection = {
          kubeconfig: state.kubeconfig,
          context: state.context,
          cleared: enabled.length === 0 && Boolean(runtime.touched),
        }
      }

      // RPC outputs are validated as JSON: drop undefined optional fields.
      return JSON.parse(JSON.stringify(state)) as StateView
    }

    function notify(sessionID: string | undefined): void {
      void registration?.events.emit("changed", { sessionID: sessionID ?? "", directory }).catch(() => undefined)
    }

    async function afterChange(sessionID: string | undefined): Promise<StateView> {
      notify(sessionID)
      return buildState(sessionID, { track: true })
    }

    async function mutateConfig(change: (next: Config) => void | Promise<void>): Promise<void> {
      const loaded = await ensureConfig(directory)
      const next = structuredClone(loaded.config)
      await change(next)
      await saveConfig(directory, next)
      discovery = undefined
      secretStore.invalidate()
    }

    // ---- command delivery --------------------------------------------------

    const grants = new Map<string, Array<{ expires: number; active: Active }>>()

    function pruneGrants(now: number) {
      for (const [key, list] of grants) {
        const alive = list.filter((grant) => grant.expires > now)
        if (alive.length) grants.set(key, alive)
        else grants.delete(key)
      }
    }

    function addGrant(command: string, active: Active) {
      pruneGrants(Date.now())
      const key = grantedKey(command)
      const list = grants.get(key) ?? []
      list.push({ expires: Date.now() + GRANT_TTL_MS, active })
      grants.set(key, list)
    }

    function takeGrant(command: string): Active | undefined {
      pruneGrants(Date.now())

      const exact = grants.get(grantedKey(command))
      if (exact?.length) {
        const grant = exact.shift()!
        if (!exact.length) grants.delete(grantedKey(command))
        return grant.active
      }

      // The shell tool may wrap or prefix the command.
      const prefix = `${directory}\u0000`
      const candidates = [...grants.keys()]
        .filter((key) => key.startsWith(prefix) && command.includes(key.slice(prefix.length)))
        .sort((left, right) => right.length - left.length)
      for (const key of candidates) {
        const list = grants.get(key)!
        const grant = list.shift()!
        if (!list.length) grants.delete(key)
        return grant.active
      }

      return undefined
    }

    function applyActive(event: { env: Record<string, string | undefined> }, active: Active) {
      if (active.kubeconfig) {
        event.env.KUBECONFIG = active.kubeconfig
        event.env.K8S_CONTEXT = active.context ?? ""
      } else if (active.cleared) {
        delete event.env.KUBECONFIG
        delete event.env.K8S_CONTEXT
      }
    }

    // ---- RPC ---------------------------------------------------------------

    const handlers = {
      state: async (input: unknown) => {
        const value = input as { sessionID?: string }
        return buildState(value.sessionID)
      },
      setContext: async (input: unknown) => {
        const value = input as { sessionID: string; context: string }
        return serial(async () => {
          const loaded = await currentConfig()
          const found = await discover(loaded.config)
          const runtime = await runtimeFor(value.sessionID)
          const enabled = new Set(resolveEnabled(loaded.config, runtime, found.sources))
          const view = buildContextView(found.sources, enabled)
          if (!view.contexts.some((item) => item.name === value.context)) {
            throw new Error(`Unknown or disabled context: ${value.context}`)
          }
          runtime.context = value.context
          await persist(value.sessionID, runtime)
          return afterChange(value.sessionID)
        })
      },
      enableSource: async (input: unknown) => {
        const value = input as { sessionID: string; source: string }
        return serial(async () => {
          const loaded = await currentConfig()
          const found = await discover(loaded.config)
          const runtime = await runtimeFor(value.sessionID)
          if (!found.sources.some((source) => source.id === value.source)) {
            throw new Error(`Unknown source: ${value.source}`)
          }
          const enabled = new Set(resolveEnabled(loaded.config, runtime, found.sources))
          enabled.add(value.source)
          runtime.enabled = found.sources.filter((source) => enabled.has(source.id)).map((source) => source.id)
          runtime.touched = true
          await persist(value.sessionID, runtime)
          return afterChange(value.sessionID)
        })
      },
      disableSource: async (input: unknown) => {
        const value = input as { sessionID: string; source: string }
        return serial(async () => {
          const loaded = await currentConfig()
          const found = await discover(loaded.config)
          const runtime = await runtimeFor(value.sessionID)
          const enabled = new Set(resolveEnabled(loaded.config, runtime, found.sources))
          enabled.delete(value.source)
          runtime.enabled = found.sources.filter((source) => enabled.has(source.id)).map((source) => source.id)
          runtime.touched = true
          if (runtime.context) {
            const view = buildContextView(found.sources, enabled)
            if (!view.contexts.some((item) => item.name === runtime.context)) runtime.context = undefined
          }
          await persist(value.sessionID, runtime)
          return afterChange(value.sessionID)
        })
      },
      setEnabled: async (input: unknown) => {
        const value = input as { sessionID: string; enabled: string[] }
        return serial(async () => {
          const loaded = await currentConfig()
          const found = await discover(loaded.config)
          const runtime = await runtimeFor(value.sessionID)
          const enabled = new Set(value.enabled)
          runtime.enabled = found.sources.filter((source) => enabled.has(source.id)).map((source) => source.id)
          runtime.touched = true
          await persist(value.sessionID, runtime)
          return afterChange(value.sessionID)
        })
      },
      syncProfile: async (input: unknown) => {
        const value = input as { sessionID: string; profile?: string }
        const runtime = await runtimeFor(value.sessionID)
        if (runtime.profile !== value.profile) {
          runtime.profile = value.profile
          await persist(value.sessionID, runtime)
          notify(value.sessionID)
        }
        return buildState(value.sessionID)
      },
      addSource: async (input: unknown) => {
        const value = input as {
          sessionID?: string
          kind: SourceConfig["kind"]
          path?: string
          entry?: string
          label?: string
        }
        return serial(async () => {
          const before = value.sessionID ? await buildState(value.sessionID) : undefined
          const found = await discover((await currentConfig()).config, true)
          const source = await makeSource(value, found.sources)
          await mutateConfig((next) => {
            if (next.sources.some((item) => item.id === source.id)) throw new Error(`Source already exists: ${source.id}`)
            next.sources.push(source)
          })
          if (value.sessionID) {
            const runtime = await runtimeFor(value.sessionID)
            const enabled = new Set(before?.enabled ?? [])
            enabled.add(source.id)
            runtime.enabled = [...enabled]
            runtime.touched = true
            await persist(value.sessionID, runtime)
          }
          return afterChange(value.sessionID)
        })
      },
      removeSource: async (input: unknown) => {
        const value = input as { sessionID?: string; id: string }
        return serial(async () => {
          if (value.id.startsWith("dir:")) {
            throw new Error("Directory sources are removed as a whole; pick the directory source instead")
          }
          await mutateConfig((next) => {
            const before = next.sources.length
            next.sources = next.sources.filter((source) => source.id !== value.id)
            if (next.sources.length === before) throw new Error(`Unknown source: ${value.id}`)
            next.defaultEnabled = next.defaultEnabled.filter((id) => id !== value.id)
            for (const profile of Object.keys(next.profileLinks)) {
              next.profileLinks[profile] = next.profileLinks[profile]!.filter((id) => id !== value.id)
            }
          })
          for (const runtime of live.values()) {
            if (runtime.enabled) {
              runtime.enabled = runtime.enabled.filter((id) => id !== value.id && !id.startsWith(`dir:${value.id}:`))
            }
          }
          return afterChange(value.sessionID)
        })
      },
      saveProfileLink: async (input: unknown) => {
        const value = input as { sessionID: string; profile: string }
        return serial(async () => {
          const profile = value.profile.trim()
          if (!profile) throw new Error("Profile name cannot be empty")
          const state = await buildState(value.sessionID)
          await mutateConfig((next) => {
            next.profileLinks[profile] = [...state.enabled]
          })
          const runtime = await runtimeFor(value.sessionID)
          runtime.profile = profile
          runtime.enabled = undefined
          runtime.touched = false
          await persist(value.sessionID, runtime)
          return afterChange(value.sessionID)
        })
      },
      clear: async (input: unknown) => {
        const value = input as { sessionID?: string }
        return serial(async () => {
          const runtime = await runtimeFor(value.sessionID)
          runtime.enabled = []
          runtime.context = undefined
          runtime.touched = true
          await persist(value.sessionID, runtime)
          if (value.sessionID) {
            const file = path.join(selectorDir, `${safeName(value.sessionID)}.yaml`)
            await fs.rm(file, { force: true }).catch(() => undefined)
            written.delete(file)
          }
          return afterChange(value.sessionID)
        })
      },
      refresh: async () => {
        discovery = undefined
        secretStore.invalidate()
        written.clear()
        return buildState(undefined, { refresh: true })
      },
      secretStoreEntries: async (): Promise<SecretListing> => secretStore.list(),
      test: async (input: unknown) => {
        const value = input as { sessionID?: string }
        const state = await buildState(value.sessionID)
        if (!state.kubeconfig) {
          return { ok: false, context: null, error: "No kubeconfigs are enabled" }
        }
        try {
          const result = (await run("kubectl", ["config", "current-context"], {
            timeout: 15_000,
            encoding: "utf8",
            env: { ...process.env, KUBECONFIG: state.kubeconfig },
          } as any)) as unknown as { stdout: string; stderr: string }
          return {
            ok: true,
            context: state.context ?? null,
            stdout: String(result.stdout ?? "").trim(),
            stderr: String(result.stderr ?? "").trim(),
            kubeconfig: state.kubeconfig,
          }
        } catch (error: any) {
          return {
            ok: false,
            context: state.context ?? null,
            error: messageOf(error),
            stderr: typeof error?.stderr === "string" ? error.stderr.trim() : "",
            kubeconfig: state.kubeconfig,
          }
        }
      },
    }

    async function makeSource(
      value: { kind: SourceConfig["kind"]; path?: string; entry?: string; label?: string },
      sources: DiscoveredSource[],
    ): Promise<SourceConfig> {
      const loaded = await currentConfig()
      const used = new Set(loaded.config.sources.map((source) => source.id))
      const uniqueId = (base: string): string => {
        const clean = safeName(base).replace(/^[^A-Za-z0-9_]+/, "") || "source"
        let id = clean
        let index = 2
        while (used.has(id) || sources.some((source) => source.id === id)) {
          id = `${clean}-${index++}`
        }
        return id
      }

      if (value.kind === "file" || value.kind === "dir") {
        const raw = (value.path ?? "").trim()
        if (!raw) throw new Error(`${value.kind} sources need a path`)
        const absolute = expandPath(raw, directory)
        const duplicate = loaded.config.sources.find(
          (source) => source.kind !== "secret-store" && source.path && expandPath(source.path, directory) === absolute,
        )
        if (duplicate) throw new Error(`Already configured as "${duplicate.label ?? duplicate.id}"`)
        if (value.kind === "file") {
          if (!(await isFile(absolute))) throw new Error(`Not a file: ${absolute}`)
          const parsed = parseKubeconfig(await fs.readFile(absolute, "utf8"), path.basename(absolute))
          if (!parsed.valid) throw new Error(parsed.error ?? `Not a kubeconfig: ${absolute}`)
        } else if (!(await isDirectory(absolute))) {
          throw new Error(`Not a directory: ${absolute}`)
        }
        const label = value.label?.trim() || path.basename(absolute)
        return {
          id: uniqueId(label.replace(/\.[^.]+$/, "")),
          kind: value.kind,
          path: raw,
          label,
        }
      }

      const entry = (value.entry ?? "").trim()
      if (!entry) throw new Error("Secret store sources need an entry")
      const duplicate = loaded.config.sources.find((source) => source.kind === "secret-store" && source.entry === entry)
      if (duplicate) throw new Error(`Already configured as "${duplicate.label ?? duplicate.id}"`)
      const found = await secretStore.entry(entry)
      if (!found) throw new Error(`Secret store entry not found: ${entry}`)
      const text = decodeKubeconfigValue(found.value, entry)
      const parsed = parseKubeconfig(text, entry)
      if (!parsed.valid) throw new Error(parsed.error ?? `${entry} is not a kubeconfig`)
      return {
        id: uniqueId(value.label?.trim() || entry.replace(/^.*\//, "")),
        kind: "secret-store",
        entry,
        label: value.label?.trim() || entry,
      }
    }

    // ---- hooks and tool ----------------------------------------------------

    const toolHook = await ctx.tool.hook("execute.before", async (event) => {
      const tool = String(event.tool ?? "").toLowerCase()
      if (tool !== "shell" && tool !== "bash") return
      const command = commandOf(event.input)
      if (!command || !event.sessionID) return

      try {
        const state = await buildState(event.sessionID, { track: true })
        addGrant(command, {
          kubeconfig: state.kubeconfig,
          context: state.context,
          cleared: state.enabled.length === 0,
        })
      } catch (error) {
        console.error("[k8s-manager] cannot prepare KUBECONFIG for command:", messageOf(error))
      }
    })

    const shellHook = await ctx.shell.hook("create.before", (event) => {
      const grant = takeGrant(event.command)
      const active = grant ?? locationSelection
      if (active) applyActive(event, active)
    })

    const contextsTool = await ctx.tool.transform((editor) => {
      editor.add({
        name: "k8s_contexts",
        description:
          "Report the Kubernetes context active for this session, the kubeconfig sources enabled for it, and the " +
          "other contexts available from those sources. Read-only: it does not switch context.",
        input: { type: "object", properties: {}, additionalProperties: false } as const,
        execute: async (_input: unknown, context: any) => {
          try {
            const state = await buildState(context?.sessionID)
            if (!state.context) {
              return {
                content: [
                  "No Kubernetes context is active.",
                  state.enabled.length
                    ? `Enabled kubeconfig sources: ${state.enabled.join(", ")} (no current-context set)`
                    : "No kubeconfig sources are enabled.",
                ].join("\n"),
              }
            }
            const contexts = state.contexts.map((item) =>
              item.name === state.context ? `${item.name} (current)` : item.name,
            )
            return {
              content: [
                `Current context: ${state.context}`,
                `Loaded from: ${state.contextSourceLabel ?? state.contextSource ?? "unknown"}`,
                `Enabled sources: ${state.sources.filter((source) => source.enabled).map((source) => source.label).join(", ") || "none"}`,
                `KUBECONFIG: ${state.kubeconfig ?? "(unset)"}`,
                "",
                `Available contexts (${contexts.length}):`,
                ...contexts.map((name) => `- ${name}`),
              ].join("\n"),
            }
          } catch (error) {
            return { content: `Cannot read Kubernetes state: ${messageOf(error)}` }
          }
        },
      })
    })

    registration = await ctx.rpc.register(K8s, handlers as any)

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ["session.deleted"], signal: controller.signal })) {
        const sessionID = (event as any).data?.sessionID
        if (typeof sessionID !== "string") continue
        live.delete(sessionID)
        await ctx.storage.remove(storageKey(sessionID)).catch(() => undefined)
        const file = path.join(selectorDir, `${safeName(sessionID)}.yaml`)
        await fs.rm(file, { force: true }).catch(() => undefined)
        written.delete(file)
      }
    })().catch(() => undefined)

    return () => {
      controller.abort()
      void toolHook.dispose()
      void shellHook.dispose()
      void contextsTool.dispose()
      void registration?.dispose()
      for (const file of written.keys()) void fs.rm(file, { force: true }).catch(() => undefined)
    }
  },
})

function commandOf(input: unknown): string | undefined {
  if (typeof input === "string") return input
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  for (const key of ["command", "cmd", "script"]) {
    if (typeof record[key] === "string") return record[key] as string
  }
  return undefined
}
