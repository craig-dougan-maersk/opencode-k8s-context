import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createResource, createSignal, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"

import { K8sRpc } from "./rpc.js"

type SourceView = {
  id: string
  label: string
  kind: "file" | "dir" | "secret-store"
  configId: string
  path?: string
  entry?: string
  fileName?: string
  available: boolean
  enabled: boolean
  contexts: Array<{ name: string; cluster?: string; user?: string; namespace?: string }>
  currentContext?: string
  error?: string
  group?: boolean
}

type ContextView = {
  name: string
  cluster?: string
  user?: string
  namespace?: string
  source: string
  sourceLabel: string
  alsoIn: string[]
}

type State = {
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

// env-manager exposes `activeProfile`; the contract is declared locally so this
// plugin has no package dependency on it. If the method is absent (older
// env-manager), automatic profile links simply stay inactive.
const ENV_MANAGER = {
  id: "env.manager",
  methods: {
    activeProfile: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          profile: { type: "string" },
          defaultProfile: { type: "string" },
        },
        required: ["profile"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const

export default Plugin.define({
  id: "k8s.manager.tui",
  setup(context: any) {
    const rpc = context.client.rpc(K8sRpc)
    const envManager = context.client.rpc(ENV_MANAGER as any)

    const [tick, setTick] = createSignal(0)
    const refresh = () => setTick((value) => value + 1)

    function toast(message: string, variant: "info" | "success" | "warning" | "error" = "info") {
      context.ui.toast.show({
        title: "Kubernetes",
        message,
        variant,
        duration: variant === "error" ? 7000 : 3500,
      })
    }

    function toastError(prefix: string, error: unknown) {
      toast(`${prefix}: ${messageOf(error)}`, "error")
    }

    function currentSessionID(): string | undefined {
      try {
        const route = context.ui.router.current()
        if (route.type === "session") return route.sessionID
      } catch {
        // The router may not be ready during early setup.
      }
      return context.ui.panel.current()?.sessionID
    }

    async function getState(sessionID?: string): Promise<State> {
      return (await rpc.state(sessionID ? { sessionID } : {})) as State
    }

    async function openMenu(startSessionID?: string): Promise<void> {
      let sessionID = startSessionID ?? currentSessionID()

      for (;;) {
        let state: State
        try {
          state = await getState(sessionID)
        } catch (error) {
          toastError("Cannot read contexts", error)
          return
        }

        if (sessionID) void syncProfile(sessionID)

        const available = state.sources.filter((source) => source.available).length
        const removable = state.configSources
        const choice = await context.ui.dialog.select({
          title: `Kubernetes — ${state.context ?? "no context"}`,
          options: [
            {
              title: "Switch cluster context…",
              value: "switch",
              description: `${state.contexts.length} available`,
              category: "Context",
            },
            {
              title: "Enable / disable kubeconfigs…",
              value: "toggle",
              description: `${state.enabled.length} enabled of ${available} available`,
              category: "Sources",
            },
            { title: "Add kubeconfig source…", value: "add", category: "Sources" },
            {
              title: "Remove a source…",
              value: "remove",
              description: removable.map((source) => source.label).join(", ") || "none configured",
              category: "Sources",
              disabled: removable.length === 0,
            },
            {
              title: "Show effective KUBECONFIG",
              value: "show",
              description: state.kubeconfig ? "paths in merge order" : "unset",
              category: "Inspect",
            },
            { title: "Test with kubectl", value: "test", category: "Inspect" },
            {
              title: "Save enabled sources as an env-manager profile link…",
              value: "link",
              description: state.profile ? `active profile: ${state.profile}` : "no profile detected",
              category: "Profiles",
              disabled: !sessionID,
            },
            {
              title: "Clear selection",
              value: "clear",
              description: "stop overriding KUBECONFIG for this session",
              category: "Session",
              disabled: !sessionID,
            },
            { title: "Refresh sources", value: "refresh", category: "Sources" },
          ],
        })
        if (!choice) return

        const needsSession = ["switch", "toggle", "add", "remove", "clear"].includes(choice)
        if (needsSession && !sessionID) {
          toast("Open a session first; kubeconfig selection is per session.", "warning")
          continue
        }

        try {
          if (choice === "switch") {
            const next = await pickContext(state)
            if (!next) continue
            if (!next.enabled) {
              const enabled = (await rpc.enableSource({ sessionID, source: next.source })) as State
              await rpc.setContext({ sessionID, context: next.name })
              toast(`Enabled ${next.sourceLabel} and selected ${next.name}`, "success")
              refresh()
            } else {
              await rpc.setContext({ sessionID, context: next.name })
              toast(`Context: ${next.name}`, "success")
              refresh()
            }
            continue
          }

          if (choice === "toggle") {
            await toggleSources(sessionID)
            refresh()
            continue
          }

          if (choice === "add") {
            await addSource(sessionID)
            refresh()
            continue
          }

          if (choice === "remove") {
            await removeSource(sessionID, state)
            refresh()
            continue
          }

          if (choice === "show") {
            await context.ui.dialog.alert({
              title: "Effective KUBECONFIG",
              message: state.kubeconfig
                ? `${state.kubeconfig}\n\nFirst entry is a selector stub; the rest are the enabled kubeconfigs, in merge order.`
                : "No kubeconfigs are enabled, so KUBECONFIG is left alone.",
            })
            continue
          }

          if (choice === "test") {
            const result: any = await rpc.test(sessionID ? { sessionID } : {})
            if (result?.ok) {
              await context.ui.dialog.alert({
                title: "kubectl config current-context",
                message: `${String(result.stdout || "(empty)")}\n\nEffective KUBECONFIG:\n${result.kubeconfig ?? "(unset)"}`,
              })
            } else {
              await context.ui.dialog.alert({
                title: "kubectl failed",
                message: `${result?.error ?? "unknown error"}${result?.stderr ? `\n\n${result.stderr}` : ""}`,
              })
            }
            continue
          }

          if (choice === "link") {
            if (!sessionID) continue
            const profile = await context.ui.dialog.prompt({
              title: "env-manager profile",
              description: "Sources enabled now are enabled automatically whenever this profile is active.",
              placeholder: "prod",
              value: state.profile ?? "",
            })
            if (!profile || !profile.trim()) continue
            await rpc.saveProfileLink({ sessionID, profile: profile.trim() })
            toast(`Linked ${state.enabled.length} source${state.enabled.length === 1 ? "" : "s"} to profile "${profile.trim()}"`, "success")
            refresh()
            continue
          }

          if (choice === "clear") {
            if (!sessionID) continue
            const confirmed = await context.ui.dialog.confirm({
              title: "Clear Kubernetes selection",
              message: "Disable every kubeconfig for this session and leave KUBECONFIG untouched?",
              label: { confirm: "Clear", cancel: "Cancel" },
            })
            if (!confirmed) continue
            await rpc.clear({ sessionID })
            toast("Selection cleared", "success")
            refresh()
            continue
          }

          if (choice === "refresh") {
            await rpc.refresh({})
            refresh()
            toast("Sources refreshed", "success")
            continue
          }
        } catch (error) {
          toastError("Kubernetes action failed", error)
        }
      }
    }

    async function pickContext(state: State): Promise<{ name: string; source: string; sourceLabel: string; enabled: boolean } | undefined> {
      const options: Array<{ title: string; value: string; description?: string; category?: string }> = []
      const seen = new Set<string>()

      const push = (contexts: Array<{ name: string; cluster?: string; namespace?: string }>, sourceId: string, sourceLabel: string, enabled: boolean) => {
        for (const item of contexts) {
          if (enabled && seen.has(item.name)) continue
          seen.add(item.name)
          options.push({
            title: `${item.name === state.context ? "✓ " : "  "}${item.name}`,
            value: JSON.stringify([sourceId, item.name]),
            description: [item.cluster, item.namespace ? `ns ${item.namespace}` : undefined, `from ${sourceLabel}`]
              .filter(Boolean)
              .join(" · "),
            category: enabled ? "Enabled" : "Disabled (will be enabled)",
          })
        }
      }

      // Enabled contexts are already merged and deduplicated: the winning
      // source is the one the context would resolve to.
      for (const item of state.contexts) push([item], item.source, item.sourceLabel, true)
      for (const source of state.sources) {
        if (!source.enabled && source.available) push(source.contexts, source.id, source.label, false)
      }

      if (!options.length) {
        await context.ui.dialog.alert({
          title: "No contexts",
          message: "No enabled kubeconfig defines a context. Enable a source or check its path.",
        })
        return undefined
      }

      const choice = await context.ui.dialog.select({
        title: "Switch context",
        placeholder: "Search contexts",
        options,
        search: (query: string, available: any[]) => {
          const needle = query.trim().toLowerCase()
          if (!needle) return available
          return available.filter(
            (option) =>
              option.title.toLowerCase().includes(needle) ||
              (option.description ?? "").toLowerCase().includes(needle),
          )
        },
      })
      if (!choice) return undefined
      let parsed: [string, string]
      try {
        parsed = JSON.parse(choice) as [string, string]
      } catch {
        return undefined
      }
      const [source, name] = parsed
      const view = state.contexts.find((item) => item.name === name)
      const owning = state.sources.find((item) => item.id === source)
      return {
        name,
        source,
        sourceLabel: view?.sourceLabel ?? owning?.label ?? source,
        enabled: Boolean(view),
      }
    }

    async function toggleSources(sessionID?: string): Promise<void> {
      for (;;) {
        const state = await getState(sessionID)
        const options = state.sources.map((source) => ({
          title: `${source.enabled ? "✓" : "  "} ${source.label}`,
          value: source.id,
          description: [
            `${source.contexts.length} context${source.contexts.length === 1 ? "" : "s"}`,
            source.kind === "secret-store" ? "secret store" : source.kind === "dir" ? "directory" : "file",
            source.error,
          ]
            .filter(Boolean)
            .join(" · "),
          category: source.available ? (source.kind === "secret-store" ? "Secret store" : source.kind === "dir" ? "Directory" : "File") : "Unavailable",
          disabled: !source.available && !source.group,
        }))
        if (!options.length) {
          await context.ui.dialog.alert({ title: "No sources", message: "Add a kubeconfig source first." })
          return
        }

        const pick = await context.ui.dialog.select({
          title: "Toggle kubeconfig (Esc to finish)",
          options,
        })
        if (!pick) return

        const source = state.sources.find((item) => item.id === pick)
        if (!source) continue
        if (source.enabled) {
          await rpc.disableSource({ sessionID, source: pick })
          toast(`Disabled ${source.label}`, "success")
        } else {
          await rpc.enableSource({ sessionID, source: pick })
          toast(`Enabled ${source.label}`, "success")
        }
        refresh()
      }
    }

    async function addSource(sessionID?: string): Promise<void> {
      const kind = await context.ui.dialog.select({
        title: "Add kubeconfig source",
        options: [
          { title: "Default ~/.kube/config", value: "default" },
          { title: "Kubeconfig file…", value: "file" },
          { title: "Kubeconfig directory…", value: "dir" },
          { title: "From the env-manager secret store…", value: "secret-store" },
        ],
      })
      if (!kind) return

      if (kind === "default") {
        await rpc.addSource({ sessionID, kind: "file", path: "~/.kube/config", label: "default" })
        toast("Added ~/.kube/config", "success")
        return
      }

      if (kind === "file" || kind === "dir") {
        const value = await context.ui.dialog.prompt({
          title: kind === "file" ? "Kubeconfig file" : "Kubeconfig directory",
          placeholder: kind === "file" ? "~/.kube/config" : "~/.kube/configs",
          description: "Paths support ~ and are relative to the work directory otherwise.",
        })
        if (!value || !value.trim()) return
        await rpc.addSource({ sessionID, kind, path: value.trim() })
        toast(`Added ${value.trim()}`, "success")
        return
      }

      const listing: any = await rpc.secretStoreEntries({})
      const entries: string[] = listing?.entries ?? []
      if (!entries.length) {
        await context.ui.dialog.alert({
          title: "No secret store entries",
          message:
            (listing?.errors?.length ? `${listing.errors.join("\n")}\n\n` : "") +
            "The env-manager secret store is not configured or could not be decrypted. Check ~/.config/opencode/env-manager.json.",
        })
        return
      }

      const entry = await context.ui.dialog.select({
        title: "Secret store kubeconfig entry",
        placeholder: "Search entries",
        options: entries.map((name) => ({
          title: name,
          value: name,
          description: "base64 kubeconfig or raw YAML",
        })),
      })
      if (!entry) return
      await rpc.addSource({ sessionID, kind: "secret-store", entry })
      toast(`Added secret store entry ${entry}`, "success")
    }

    async function removeSource(sessionID: string | undefined, state: State): Promise<void> {
      const choice = await context.ui.dialog.select({
        title: "Remove source",
        options: state.configSources.map((source) => ({
          title: source.label,
          value: source.id,
          description: `${source.kind} · ${source.id}`,
        })),
      })
      if (!choice) return
      const confirmed = await context.ui.dialog.confirm({
        title: "Remove source",
        message: `Remove ${choice} from ${state.configPath}? Enabled sessions stop seeing it.`,
        label: { confirm: "Remove", cancel: "Cancel" },
      })
      if (!confirmed) return
      await rpc.removeSource({ sessionID, id: choice })
      toast(`Removed ${choice}`, "success")
    }

    // ---- env-manager profile linking --------------------------------------

    const profiles = new Map<string, string | undefined>()

    async function syncProfile(sessionID: string): Promise<void> {
      try {
        const result: any = await envManager.activeProfile({ sessionID })
        const profile = typeof result?.profile === "string" ? result.profile : undefined
        if (profiles.get(sessionID) === profile) return
        profiles.set(sessionID, profile)
        await rpc.syncProfile({ sessionID, profile })
        refresh()
      } catch {
        // env-manager is not installed, or predates activeProfile.
      }
    }

    // ---- status bar --------------------------------------------------------

    function statusText(state: State | undefined, showDetails: boolean): string {
      if (!state) return "⎈ …"
      if (!state.context) {
        return state.enabled.length ? "⎈ (no context)" : "⎈ none"
      }
      const name = state.context.length > (showDetails ? 48 : 28) && !showDetails
        ? `${state.context.slice(0, 27)}…`
        : state.context
      return showDetails && state.contextSourceLabel ? `⎈ ${name} · ${state.contextSourceLabel}` : `⎈ ${name}`
    }

    function stateColor(ctx: any, state: State | undefined): any {
      if (!state?.context) return ctx.theme.text.muted
      const source = state.sources.find((item) => item.id === state.contextSource)
      if (source?.kind === "secret-store") return ctx.theme.text.warning
      if (source?.kind === "dir") return ctx.theme.text.info ?? ctx.theme.text.base
      return ctx.theme.text.success
    }

    function Status(props: { sessionID?: string; showDetails: boolean }) {
      const ctx = usePlugin()
      const [state] = createResource(
        () => [props.sessionID, tick()] as const,
        async ([sessionID]) => {
          try {
            return (await rpc.state(sessionID ? { sessionID } : {})) as State
          } catch {
            return undefined
          }
        },
      )
      return (
        <text fg={stateColor(ctx, state())}> {statusText(state(), props.showDetails)} </text>
      )
    }

    context.ui.slot({
      append: "prompt.footer.status",
      render: (input: any) => <Status sessionID={input.sessionID} showDetails={input.showDetails !== false} />,
    })

    context.ui.slot({
      append: "home.footer.status",
      render: () => <Status showDetails={true} />,
    })

    // ---- sidebar -----------------------------------------------------------

    function Sidebar(props: { sessionID?: string }) {
      const ctx = usePlugin()
      const [open, setOpen] = createSignal(true)
      const [state] = createResource(
        () => [props.sessionID, tick()] as const,
        async ([sessionID]) => {
          try {
            return (await rpc.state(sessionID ? { sessionID } : {})) as State
          } catch {
            return undefined
          }
        },
      )

      const toggle = (event: any) => {
        try {
          event?.stopPropagation?.()
        } catch {}
        setOpen(!open())
      }

      return (
        <box flexDirection="column" marginTop={1}>
          <box {...({ onClick: toggle, onMouseDown: toggle } as any)}>
            <text fg={ctx.theme.text.base} attributes={TextAttributes.BOLD}>
              {(open() ? "▼ " : "▶ ") + "Kubernetes"}
            </text>
          </box>
          <Show when={open()}>
            <box
              flexDirection="column"
              paddingLeft={1}
              {...({ onClick: () => void openMenu(), onMouseDown: () => void openMenu() } as any)}
            >
              <Show
                when={state()?.context}
                fallback={<text fg={ctx.theme.text.muted}>no context active</text>}
              >
                <text fg={stateColor(ctx, state())}>{`⎈ ${state()!.context}`}</text>
                <text fg={ctx.theme.text.muted}>{`from ${state()!.contextSourceLabel ?? "unknown"}`}</text>
              </Show>
              <text fg={ctx.theme.text.muted}>
                {`${state()?.enabled.length ?? 0} source${(state()?.enabled.length ?? 0) === 1 ? "" : "s"} · /k8s`}
              </text>
              <Show when={(state()?.warnings.length ?? 0) > 0}>
                <text fg={ctx.theme.text.warning}>{`⚠ ${state()!.warnings.length} warning${state()!.warnings.length === 1 ? "" : "s"}`}</text>
              </Show>
            </box>
          </Show>
        </box>
      )
    }

    context.ui.slot({
      append: "sidebar.content",
      render: (input: any) => <Sidebar sessionID={input.sessionID} />,
    })

    // ---- commands and lifecycle -------------------------------------------

    context.keymap.layer(() => ({
      mode: "global",
      priority: 20,
      commands: [
        {
          id: "k8s.manager.menu",
          title: "Kubernetes contexts",
          description: "Switch context and manage the kubeconfigs enabled for this session",
          group: "Kubernetes",
          palette: true,
          slash: { name: "k8s", aliases: ["kube", "kubectx"] },
          run: async () => {
            try {
              await openMenu()
            } catch (error) {
              toastError("Kubernetes", error)
            }
          },
        },
      ],
    }))

    const unsubscribeRpc = rpc.events.on("changed", () => refresh())
    const unsubscribeStarted = context.data.on("session.execution.started", (event: any) => {
      const sessionID = event?.data?.sessionID
      if (typeof sessionID === "string") void syncProfile(sessionID)
    })

    const initial = currentSessionID()
    if (initial) void syncProfile(initial)

    return () => {
      unsubscribeRpc()
      unsubscribeStarted()
    }
  },
})

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
