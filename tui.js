// src/tui.tsx
import { spread as _$spread } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { createResource, createSignal, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var string = { type: "string" };
var result = { type: "object", additionalProperties: true };
var sessionInput = {
  type: "object",
  properties: { sessionID: string },
  additionalProperties: false
};
var sessionSourceInput = {
  type: "object",
  properties: { sessionID: string, source: string },
  required: ["sessionID", "source"],
  additionalProperties: false
};
var K8s = Rpc.define({
  id: "k8s.manager",
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { sessionID: string, directory: string },
        required: ["sessionID", "directory"],
        additionalProperties: false
      }
    }
  },
  methods: {
    state: {
      input: {
        type: "object",
        properties: { sessionID: string },
        additionalProperties: false
      },
      output: result
    },
    setContext: {
      input: {
        type: "object",
        properties: { sessionID: string, context: string },
        required: ["sessionID", "context"],
        additionalProperties: false
      },
      output: result
    },
    enableSource: { input: sessionSourceInput, output: result },
    disableSource: { input: sessionSourceInput, output: result },
    setEnabled: {
      input: {
        type: "object",
        properties: {
          sessionID: string,
          enabled: { type: "array", items: string }
        },
        required: ["sessionID", "enabled"],
        additionalProperties: false
      },
      output: result
    },
    syncProfile: {
      input: {
        type: "object",
        properties: { sessionID: string, profile: string },
        required: ["sessionID"],
        additionalProperties: false
      },
      output: result
    },
    addSource: {
      input: {
        type: "object",
        properties: {
          sessionID: string,
          kind: { type: "string", enum: ["file", "dir", "vault"] },
          path: string,
          entry: string,
          label: string
        },
        required: ["kind"],
        additionalProperties: false
      },
      output: result
    },
    removeSource: {
      input: {
        type: "object",
        properties: { sessionID: string, id: string },
        required: ["id"],
        additionalProperties: false
      },
      output: result
    },
    saveProfileLink: {
      input: {
        type: "object",
        properties: { sessionID: string, profile: string },
        required: ["sessionID", "profile"],
        additionalProperties: false
      },
      output: result
    },
    clear: { input: sessionInput, output: result },
    refresh: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: result
    },
    vaultEntries: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: result
    },
    test: { input: sessionInput, output: result }
  }
});
var K8sRpc = K8s;

// src/tui.tsx
var ENV_MANAGER = {
  id: "env.manager",
  methods: {
    activeProfile: {
      input: {
        type: "object",
        properties: {
          sessionID: {
            type: "string"
          }
        },
        required: ["sessionID"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          profile: {
            type: "string"
          },
          defaultProfile: {
            type: "string"
          }
        },
        required: ["profile"],
        additionalProperties: false
      }
    }
  },
  events: {}
};
var tui_default = Plugin.define({
  id: "k8s.manager.tui",
  setup(context) {
    const rpc = context.client.rpc(K8sRpc);
    const envManager = context.client.rpc(ENV_MANAGER);
    const [tick, setTick] = createSignal(0);
    const refresh = () => setTick((value) => value + 1);
    function toast(message, variant = "info") {
      context.ui.toast.show({
        title: "Kubernetes",
        message,
        variant,
        duration: variant === "error" ? 7e3 : 3500
      });
    }
    function toastError(prefix, error) {
      toast(`${prefix}: ${messageOf(error)}`, "error");
    }
    function currentSessionID() {
      try {
        const route = context.ui.router.current();
        if (route.type === "session") return route.sessionID;
      } catch {
      }
      return context.ui.panel.current()?.sessionID;
    }
    async function getState(sessionID) {
      return await rpc.state(sessionID ? {
        sessionID
      } : {});
    }
    async function openMenu(startSessionID) {
      let sessionID = startSessionID ?? currentSessionID();
      for (; ; ) {
        let state;
        try {
          state = await getState(sessionID);
        } catch (error) {
          toastError("Cannot read contexts", error);
          return;
        }
        if (sessionID) void syncProfile(sessionID);
        const available = state.sources.filter((source) => source.available).length;
        const removable = state.configSources;
        const choice = await context.ui.dialog.select({
          title: `Kubernetes \u2014 ${state.context ?? "no context"}`,
          options: [{
            title: "Switch cluster context\u2026",
            value: "switch",
            description: `${state.contexts.length} available`,
            category: "Context"
          }, {
            title: "Enable / disable kubeconfigs\u2026",
            value: "toggle",
            description: `${state.enabled.length} enabled of ${available} available`,
            category: "Sources"
          }, {
            title: "Add kubeconfig source\u2026",
            value: "add",
            category: "Sources"
          }, {
            title: "Remove a source\u2026",
            value: "remove",
            description: removable.map((source) => source.label).join(", ") || "none configured",
            category: "Sources",
            disabled: removable.length === 0
          }, {
            title: "Show effective KUBECONFIG",
            value: "show",
            description: state.kubeconfig ? "paths in merge order" : "unset",
            category: "Inspect"
          }, {
            title: "Test with kubectl",
            value: "test",
            category: "Inspect"
          }, {
            title: "Save enabled sources as an env-manager profile link\u2026",
            value: "link",
            description: state.profile ? `active profile: ${state.profile}` : "no profile detected",
            category: "Profiles",
            disabled: !sessionID
          }, {
            title: "Clear selection",
            value: "clear",
            description: "stop overriding KUBECONFIG for this session",
            category: "Session",
            disabled: !sessionID
          }, {
            title: "Refresh sources",
            value: "refresh",
            category: "Sources"
          }]
        });
        if (!choice) return;
        const needsSession = ["switch", "toggle", "add", "remove", "clear"].includes(choice);
        if (needsSession && !sessionID) {
          toast("Open a session first; kubeconfig selection is per session.", "warning");
          continue;
        }
        try {
          if (choice === "switch") {
            const next = await pickContext(state);
            if (!next) continue;
            if (!next.enabled) {
              const enabled = await rpc.enableSource({
                sessionID,
                source: next.source
              });
              await rpc.setContext({
                sessionID,
                context: next.name
              });
              toast(`Enabled ${next.sourceLabel} and selected ${next.name}`, "success");
              refresh();
            } else {
              await rpc.setContext({
                sessionID,
                context: next.name
              });
              toast(`Context: ${next.name}`, "success");
              refresh();
            }
            continue;
          }
          if (choice === "toggle") {
            await toggleSources(sessionID);
            refresh();
            continue;
          }
          if (choice === "add") {
            await addSource(sessionID);
            refresh();
            continue;
          }
          if (choice === "remove") {
            await removeSource(sessionID, state);
            refresh();
            continue;
          }
          if (choice === "show") {
            await context.ui.dialog.alert({
              title: "Effective KUBECONFIG",
              message: state.kubeconfig ? `${state.kubeconfig}

First entry is a selector stub; the rest are the enabled kubeconfigs, in merge order.` : "No kubeconfigs are enabled, so KUBECONFIG is left alone."
            });
            continue;
          }
          if (choice === "test") {
            const result2 = await rpc.test(sessionID ? {
              sessionID
            } : {});
            if (result2?.ok) {
              await context.ui.dialog.alert({
                title: "kubectl config current-context",
                message: `${String(result2.stdout || "(empty)")}

Effective KUBECONFIG:
${result2.kubeconfig ?? "(unset)"}`
              });
            } else {
              await context.ui.dialog.alert({
                title: "kubectl failed",
                message: `${result2?.error ?? "unknown error"}${result2?.stderr ? `

${result2.stderr}` : ""}`
              });
            }
            continue;
          }
          if (choice === "link") {
            if (!sessionID) continue;
            const profile = await context.ui.dialog.prompt({
              title: "env-manager profile",
              description: "Sources enabled now are enabled automatically whenever this profile is active.",
              placeholder: "prod",
              value: state.profile ?? ""
            });
            if (!profile || !profile.trim()) continue;
            await rpc.saveProfileLink({
              sessionID,
              profile: profile.trim()
            });
            toast(`Linked ${state.enabled.length} source${state.enabled.length === 1 ? "" : "s"} to profile "${profile.trim()}"`, "success");
            refresh();
            continue;
          }
          if (choice === "clear") {
            if (!sessionID) continue;
            const confirmed = await context.ui.dialog.confirm({
              title: "Clear Kubernetes selection",
              message: "Disable every kubeconfig for this session and leave KUBECONFIG untouched?",
              label: {
                confirm: "Clear",
                cancel: "Cancel"
              }
            });
            if (!confirmed) continue;
            await rpc.clear({
              sessionID
            });
            toast("Selection cleared", "success");
            refresh();
            continue;
          }
          if (choice === "refresh") {
            await rpc.refresh({});
            refresh();
            toast("Sources refreshed", "success");
            continue;
          }
        } catch (error) {
          toastError("Kubernetes action failed", error);
        }
      }
    }
    async function pickContext(state) {
      const options = [];
      const seen = /* @__PURE__ */ new Set();
      const push = (contexts, sourceId, sourceLabel, enabled) => {
        for (const item of contexts) {
          if (enabled && seen.has(item.name)) continue;
          seen.add(item.name);
          options.push({
            title: `${item.name === state.context ? "\u2713 " : "  "}${item.name}`,
            value: JSON.stringify([sourceId, item.name]),
            description: [item.cluster, item.namespace ? `ns ${item.namespace}` : void 0, `from ${sourceLabel}`].filter(Boolean).join(" \xB7 "),
            category: enabled ? "Enabled" : "Disabled (will be enabled)"
          });
        }
      };
      for (const item of state.contexts) push([item], item.source, item.sourceLabel, true);
      for (const source2 of state.sources) {
        if (!source2.enabled && source2.available) push(source2.contexts, source2.id, source2.label, false);
      }
      if (!options.length) {
        await context.ui.dialog.alert({
          title: "No contexts",
          message: "No enabled kubeconfig defines a context. Enable a source or check its path."
        });
        return void 0;
      }
      const choice = await context.ui.dialog.select({
        title: "Switch context",
        placeholder: "Search contexts",
        options,
        search: (query, available) => {
          const needle = query.trim().toLowerCase();
          if (!needle) return available;
          return available.filter((option) => option.title.toLowerCase().includes(needle) || (option.description ?? "").toLowerCase().includes(needle));
        }
      });
      if (!choice) return void 0;
      let parsed;
      try {
        parsed = JSON.parse(choice);
      } catch {
        return void 0;
      }
      const [source, name] = parsed;
      const view = state.contexts.find((item) => item.name === name);
      const owning = state.sources.find((item) => item.id === source);
      return {
        name,
        source,
        sourceLabel: view?.sourceLabel ?? owning?.label ?? source,
        enabled: Boolean(view)
      };
    }
    async function toggleSources(sessionID) {
      for (; ; ) {
        const state = await getState(sessionID);
        const options = state.sources.map((source2) => ({
          title: `${source2.enabled ? "\u2713" : "  "} ${source2.label}`,
          value: source2.id,
          description: [`${source2.contexts.length} context${source2.contexts.length === 1 ? "" : "s"}`, source2.kind === "vault" ? "vault" : source2.kind === "dir" ? "directory" : "file", source2.error].filter(Boolean).join(" \xB7 "),
          category: source2.available ? source2.kind === "vault" ? "Vault" : source2.kind === "dir" ? "Directory" : "File" : "Unavailable",
          disabled: !source2.available && !source2.group
        }));
        if (!options.length) {
          await context.ui.dialog.alert({
            title: "No sources",
            message: "Add a kubeconfig source first."
          });
          return;
        }
        const pick = await context.ui.dialog.select({
          title: "Toggle kubeconfig (Esc to finish)",
          options
        });
        if (!pick) return;
        const source = state.sources.find((item) => item.id === pick);
        if (!source) continue;
        if (source.enabled) {
          await rpc.disableSource({
            sessionID,
            source: pick
          });
          toast(`Disabled ${source.label}`, "success");
        } else {
          await rpc.enableSource({
            sessionID,
            source: pick
          });
          toast(`Enabled ${source.label}`, "success");
        }
        refresh();
      }
    }
    async function addSource(sessionID) {
      const kind = await context.ui.dialog.select({
        title: "Add kubeconfig source",
        options: [{
          title: "Default ~/.kube/config",
          value: "default"
        }, {
          title: "Kubeconfig file\u2026",
          value: "file"
        }, {
          title: "Kubeconfig directory\u2026",
          value: "dir"
        }, {
          title: "From the env-manager vault\u2026",
          value: "vault"
        }]
      });
      if (!kind) return;
      if (kind === "default") {
        await rpc.addSource({
          sessionID,
          kind: "file",
          path: "~/.kube/config",
          label: "default"
        });
        toast("Added ~/.kube/config", "success");
        return;
      }
      if (kind === "file" || kind === "dir") {
        const value = await context.ui.dialog.prompt({
          title: kind === "file" ? "Kubeconfig file" : "Kubeconfig directory",
          placeholder: kind === "file" ? "~/.kube/config" : "~/.kube/configs",
          description: "Paths support ~ and are relative to the work directory otherwise."
        });
        if (!value || !value.trim()) return;
        await rpc.addSource({
          sessionID,
          kind,
          path: value.trim()
        });
        toast(`Added ${value.trim()}`, "success");
        return;
      }
      const listing = await rpc.vaultEntries({});
      const entries = listing?.entries ?? [];
      if (!entries.length) {
        await context.ui.dialog.alert({
          title: "No vault entries",
          message: (listing?.errors?.length ? `${listing.errors.join("\n")}

` : "") + "The env-manager vault is not configured or could not be decrypted. Check ~/.config/opencode/env-manager.json."
        });
        return;
      }
      const entry = await context.ui.dialog.select({
        title: "Vault kubeconfig entry",
        placeholder: "Search entries",
        options: entries.map((name) => ({
          title: name,
          value: name,
          description: "base64 kubeconfig or raw YAML"
        }))
      });
      if (!entry) return;
      await rpc.addSource({
        sessionID,
        kind: "vault",
        entry
      });
      toast(`Added vault entry ${entry}`, "success");
    }
    async function removeSource(sessionID, state) {
      const choice = await context.ui.dialog.select({
        title: "Remove source",
        options: state.configSources.map((source) => ({
          title: source.label,
          value: source.id,
          description: `${source.kind} \xB7 ${source.id}`
        }))
      });
      if (!choice) return;
      const confirmed = await context.ui.dialog.confirm({
        title: "Remove source",
        message: `Remove ${choice} from ${state.configPath}? Enabled sessions stop seeing it.`,
        label: {
          confirm: "Remove",
          cancel: "Cancel"
        }
      });
      if (!confirmed) return;
      await rpc.removeSource({
        sessionID,
        id: choice
      });
      toast(`Removed ${choice}`, "success");
    }
    const profiles = /* @__PURE__ */ new Map();
    async function syncProfile(sessionID) {
      try {
        const result2 = await envManager.activeProfile({
          sessionID
        });
        const profile = typeof result2?.profile === "string" ? result2.profile : void 0;
        if (profiles.get(sessionID) === profile) return;
        profiles.set(sessionID, profile);
        await rpc.syncProfile({
          sessionID,
          profile
        });
        refresh();
      } catch {
      }
    }
    function statusText(state, showDetails) {
      if (!state) return "\u2388 \u2026";
      if (!state.context) {
        return state.enabled.length ? "\u2388 (no context)" : "\u2388 none";
      }
      const name = state.context.length > (showDetails ? 48 : 28) && !showDetails ? `${state.context.slice(0, 27)}\u2026` : state.context;
      return showDetails && state.contextSourceLabel ? `\u2388 ${name} \xB7 ${state.contextSourceLabel}` : `\u2388 ${name}`;
    }
    function stateColor(ctx, state) {
      if (!state?.context) return ctx.theme.text.muted;
      const source = state.sources.find((item) => item.id === state.contextSource);
      if (source?.kind === "vault") return ctx.theme.text.warning;
      if (source?.kind === "dir") return ctx.theme.text.info ?? ctx.theme.text.base;
      return ctx.theme.text.success;
    }
    function Status(props) {
      const ctx = usePlugin();
      const [state] = createResource(() => [props.sessionID, tick()], async ([sessionID]) => {
        try {
          return await rpc.state(sessionID ? {
            sessionID
          } : {});
        } catch {
          return void 0;
        }
      });
      return (() => {
        var _el$ = _$createElement("text"), _el$2 = _$createTextNode(` `), _el$3 = _$createTextNode(` `);
        _$insertNode(_el$, _el$2);
        _$insertNode(_el$, _el$3);
        _$insert(_el$, () => statusText(state(), props.showDetails), _el$3);
        _$effect((_$p) => _$setProp(_el$, "fg", stateColor(ctx, state()), _$p));
        return _el$;
      })();
    }
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => _$createComponent(Status, {
        get sessionID() {
          return input.sessionID;
        },
        get showDetails() {
          return input.showDetails !== false;
        }
      })
    });
    context.ui.slot({
      append: "home.footer.status",
      render: () => _$createComponent(Status, {
        showDetails: true
      })
    });
    function Sidebar(props) {
      const ctx = usePlugin();
      const [open, setOpen] = createSignal(true);
      const [state] = createResource(() => [props.sessionID, tick()], async ([sessionID]) => {
        try {
          return await rpc.state(sessionID ? {
            sessionID
          } : {});
        } catch {
          return void 0;
        }
      });
      const toggle = (event) => {
        try {
          event?.stopPropagation?.();
        } catch {
        }
        setOpen(!open());
      };
      return (() => {
        var _el$4 = _$createElement("box"), _el$5 = _$createElement("box"), _el$6 = _$createElement("text");
        _$insertNode(_el$4, _el$5);
        _$setProp(_el$4, "flexDirection", "column");
        _$setProp(_el$4, "marginTop", 1);
        _$insertNode(_el$5, _el$6);
        _$spread(_el$5, {
          onClick: toggle,
          onMouseDown: toggle
        }, true);
        _$insert(_el$6, () => (open() ? "\u25BC " : "\u25B6 ") + "Kubernetes");
        _$insert(_el$4, _$createComponent(Show, {
          get when() {
            return open();
          },
          get children() {
            var _el$7 = _$createElement("box"), _el$0 = _$createElement("text");
            _$insertNode(_el$7, _el$0);
            _$setProp(_el$7, "flexDirection", "column");
            _$setProp(_el$7, "paddingLeft", 1);
            _$spread(_el$7, {
              onClick: () => void openMenu(),
              onMouseDown: () => void openMenu()
            }, true);
            _$insert(_el$7, _$createComponent(Show, {
              get when() {
                return state()?.context;
              },
              get fallback() {
                return (() => {
                  var _el$10 = _$createElement("text");
                  _$insertNode(_el$10, _$createTextNode(`no context active`));
                  _$effect((_$p) => _$setProp(_el$10, "fg", ctx.theme.text.muted, _$p));
                  return _el$10;
                })();
              },
              get children() {
                return [(() => {
                  var _el$8 = _$createElement("text");
                  _$insert(_el$8, () => `\u2388 ${state().context}`);
                  _$effect((_$p) => _$setProp(_el$8, "fg", stateColor(ctx, state()), _$p));
                  return _el$8;
                })(), (() => {
                  var _el$9 = _$createElement("text");
                  _$insert(_el$9, () => `from ${state().contextSourceLabel ?? "unknown"}`);
                  _$effect((_$p) => _$setProp(_el$9, "fg", ctx.theme.text.muted, _$p));
                  return _el$9;
                })()];
              }
            }), _el$0);
            _$insert(_el$0, () => `${state()?.enabled.length ?? 0} source${(state()?.enabled.length ?? 0) === 1 ? "" : "s"} \xB7 /k8s`);
            _$insert(_el$7, _$createComponent(Show, {
              get when() {
                return (state()?.warnings.length ?? 0) > 0;
              },
              get children() {
                var _el$1 = _$createElement("text");
                _$insert(_el$1, () => `\u26A0 ${state().warnings.length} warning${state().warnings.length === 1 ? "" : "s"}`);
                _$effect((_$p) => _$setProp(_el$1, "fg", ctx.theme.text.warning, _$p));
                return _el$1;
              }
            }), null);
            _$effect((_$p) => _$setProp(_el$0, "fg", ctx.theme.text.muted, _$p));
            return _el$7;
          }
        }), null);
        _$effect((_p$) => {
          var _v$ = ctx.theme.text.base, _v$2 = TextAttributes.BOLD;
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$6, "fg", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$6, "attributes", _v$2, _p$.t));
          return _p$;
        }, {
          e: void 0,
          t: void 0
        });
        return _el$4;
      })();
    }
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => _$createComponent(Sidebar, {
        get sessionID() {
          return input.sessionID;
        }
      })
    });
    context.keymap.layer(() => ({
      mode: "global",
      priority: 20,
      commands: [{
        id: "k8s.manager.menu",
        title: "Kubernetes contexts",
        description: "Switch context and manage the kubeconfigs enabled for this session",
        group: "Kubernetes",
        palette: true,
        slash: {
          name: "k8s",
          aliases: ["kube", "kubectx"]
        },
        run: async () => {
          try {
            await openMenu();
          } catch (error) {
            toastError("Kubernetes", error);
          }
        }
      }]
    }));
    const unsubscribeRpc = rpc.events.on("changed", () => refresh());
    const unsubscribeStarted = context.data.on("session.execution.started", (event) => {
      const sessionID = event?.data?.sessionID;
      if (typeof sessionID === "string") void syncProfile(sessionID);
    });
    const initial = currentSessionID();
    if (initial) void syncProfile(initial);
    return () => {
      unsubscribeRpc();
      unsubscribeStarted();
    };
  }
});
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
export {
  tui_default as default
};
