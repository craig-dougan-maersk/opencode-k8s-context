# opencode-k8s-manager

An [OpenCode](https://opencode.ai) plugin that manages Kubernetes contexts for
OpenCode's shell commands.

It shows the active context in the status bar and sidebar, switches contexts,
and lets you choose which kubeconfig sources are enabled per session. Sources
can come from a kubeconfig file, a directory of kubeconfig files, or entries in
the [env-manager](https://github.com/craig-dougan-maersk/opencode-env-manager)
secret store. Sources can be linked to env-manager profiles so the right
clusters are enabled automatically.

## Features

- Status bar indicator: `⎈ <context> · <source>`, colour-coded by source kind.
- Collapsible **Kubernetes** section in the sidebar.
- `/k8s` menu for switching context and enabling/disabling sources.
- File, directory and secret-store sources, with per-file toggling inside directories.
- Contexts and sources are per session; other sessions keep their own selection.
- Never writes `~/.kube/config` and never copies credentials unnecessarily.
- Read-only `k8s_contexts` tool so the agent knows which cluster it is using.
- Optional env-manager profile links and per-command approval-free delivery via
  the shell hook.

## Install

From GitHub:

```jsonc
{
  "plugins": ["github:craig-dougan-maersk/opencode-k8s-context"]
}
```

From a checkout:

```bash
git clone git@github.com:craig-dougan-maersk/opencode-k8s-context.git ~/plugins/k8s-manager
```

```jsonc
{
  "plugins": ["/home/you/plugins/k8s-manager"]
}
```

Local checkouts load `src/index.ts` directly, so server changes hot-reload.
Installs resolve the package `exports` map and use the prebuilt `tui.js`; see
[Development](#development) when changing the TUI.

Requirements: `kubectl` for the optional “Test with kubectl” action, and `age`
only when using secret-store sources.

## Quick start

1. Open a session and run `/k8s` (aliases `/kube`, `/kubectx`).
2. The default source is `~/.kube/config`. Add more sources with
   **Add kubeconfig source…**.
3. Use **Switch cluster context…** to pick a context. Choosing a context from a
   disabled source enables that source first.
4. Use **Enable / disable kubeconfigs…** to toggle individual files; press Esc to
   finish.

The config file is created on the first change at
`<workdir>/.opencode/k8s-contexts.json`. Reads fall back to
`~/.config/opencode/k8s-manager.json`, and both are merged by source id.

The first shell command after a change sees the new `KUBECONFIG`; no restart is
needed.

## Sources

```jsonc
{
  "version": 1,
  "sources": [
    { "id": "default", "kind": "file", "path": "~/.kube/config", "label": "default" },
    { "id": "configs", "kind": "dir", "path": "~/.kube/configs", "label": "kubeconfigs" },
    { "id": "prod", "kind": "secret-store", "entry": "k8s/prod", "label": "prod" }
  ],
  "defaultEnabled": ["default"],
  "profileLinks": {},
  "secretStore": { "inherit": true }
}
```

- `file` — one kubeconfig. Paths support `~`, `$HOME/` and absolute paths;
  anything else is relative to the work directory.
- `dir` — every regular file in the directory becomes its own selectable source
  (`dir:<id>:<file>`), labelled `label/<file>`. Hidden files are ignored.
  Toggling a directory source enables all of its files. Disabled files stay
  discovered but are not part of `KUBECONFIG`. A missing or empty directory is
  shown as unavailable rather than failing the plugin.
- `secret-store` — an entry in the env-manager secret store. The entry must
  hold either raw kubeconfig YAML or its base64 encoding (recommended, because
  the store holds one `NAME=value` line per entry):

  ```bash
  base64 -w0 ~/.kube/prod.yaml     # paste the output after k8s_prod=
  ```

  With `secretStore.inherit: true` (the default) the plugin reuses the layers
  from `~/.config/opencode/env-manager.json` and the project's
  `.opencode/env-profiles.json`. Set `secretStore.stores` to override them.

  The pre-rename `"kind": "vault"` and `"vault": {…}` config key are still
  accepted; the next save writes them as `secret-store` and `secretStore`.

## Profile links

`profileLinks` maps an env-manager profile name to the sources enabled when that
profile is active:

```jsonc
"profileLinks": {
  "prod": ["default", "prod"],
  "dev": ["default", "configs"]
}
```

- Source ids may be config ids (a directory id enables every file in it) or a
  concrete `dir:<id>:<file>` id.
- New sessions use `defaultEnabled` unless the session's env-manager profile has
  a link.
- As soon as you toggle a source by hand, that session keeps its explicit
  selection; links no longer override it.
- **Save enabled sources as an env-manager profile link…** writes the current
  selection into `profileLinks` and switches the session to that profile.

Automatic links need env-manager's `activeProfile` RPC. If it is unavailable the
plugin stays quiet and only `defaultEnabled` applies.

## How switching works

For the selected context the plugin writes a selector stub under
`~/.local/state/opencode/k8s/sessions/`:

```yaml
apiVersion: v1
kind: Config
current-context: pipedream-prod-app-ew-01-sa-clusteradmin
```

and sets:

```
KUBECONFIG=<selector>:<enabled kubeconfig paths…>
```

Client-go's merge rules make the first file's `current-context` win, so the
source kubeconfigs are never modified and their credentials are never copied.
Secret-store sources are the exception: they are decrypted to a `0600` file
under `~/.local/state/opencode/k8s/secret-store/`, deleted when the source stops
being configured.

`KUBECONFIG` is injected through `shell.create.before`, which means it applies
to the command OpenCode is about to run, per session. The same value is applied
for the location so `!` commands see the last selection.

Selecting **Clear selection** removes `KUBECONFIG` from the environment of new
commands, restoring the ambient `~/.kube/config` behaviour, and deletes the
session's selector stub.

## Commands

| Command | Description |
| --- | --- |
| `/k8s` (or `/kube`, `/kubectx`) | Open the Kubernetes menu |
| Palette → **Kubernetes contexts** | Same menu |
| Agent tool `k8s_contexts` | Report the active context, enabled sources and available contexts |

The menu can:

- switch cluster context, grouped by source and searchable
- enable/disable kubeconfigs with ✓ marks
- add file, directory or secret-store sources
- remove configured sources
- show the effective `KUBECONFIG` and check it with
  `kubectl config current-context`
- save profile links, clear the session selection, refresh discovery

## Security

- Never writes `~/.kube/config`.
- Selector stubs contain no credentials; secret-store kubeconfigs are written
  with `0600` in a `0700` directory and removed when unused.
- Kubeconfig contents are parsed for context, cluster and user names only; keys,
  tokens and certificate data are never logged, returned by RPC or rendered.
- The secret store is decrypted only when a secret-store source is read (on
  discovery or an explicit refresh) or when you add one.
- The server never returns decrypted secret-store values over RPC. The TUI receives
  only entry names; the kubeconfig text stays on the server.

## Limitations

- Selection is session-scoped, not machine-wide. Your own terminal is untouched.
- `KUBECONFIG` is injected for commands OpenCode executes. Programs launched
  outside OpenCode (or by MCP servers with their own environment) are not
  affected.
- A location-level fallback is used for commands that do not pass through the
  shell tool, so `!` commands use the most recent selection in that work
  directory.
- Duplicate context names across enabled sources: the first source in merge
  order wins; the menu reports that the name is also defined elsewhere.
- Automatic profile links require env-manager with the `activeProfile` RPC.
- The project config is authoritative after the first write: mutations save the
  merged configuration to `<workdir>/.opencode/k8s-contexts.json`.

## Development

```bash
npm install
npm test          # node:test suites, including a real age decrypt round-trip
npm run typecheck
npm run compile   # regenerates tui.js (esbuild + babel-preset-solid)
```

`tui.js` is committed because Git/npm installs resolve the `exports` map instead
of transforming plugin sources. It is built with Babel's Solid preset
(`generate: "universal"`), then bundled with esbuild; the server part remains
TypeScript and is loaded by OpenCode's own runtime.

The script is called `compile`, not `build`, on purpose: OpenCode's plugin
installer executes a git package's `build` script while preparing the
dependency, before the package's dev dependencies are reliably available, which
makes GitHub installs fail. Keep the TUI rebuild manual.

Layout:

```
src/index.ts       server: discovery, state, RPC, shell hook
src/config.ts      project/global config loading and merging
src/kubeconfig.ts   YAML parsing, merge view, selector stubs, base64 decoding
src/secret-store.ts env-manager-compatible age secret store reader (local-age)
src/rpc.ts          typed RPC contract (also exported as ./rpc)
src/tui.tsx         status bar, sidebar, /k8s menu
tui.js              prebuilt TUI bundle
test/               unit and age integration tests
```

## License

MIT
