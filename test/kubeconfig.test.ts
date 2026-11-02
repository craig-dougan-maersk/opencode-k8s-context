import assert from "node:assert/strict"
import test from "node:test"

import {
  buildContextView,
  decodeKubeconfigValue,
  expandSelection,
  kubeconfigValue,
  parseKubeconfig,
  selectorYaml,
  type DiscoveredSource,
} from "../src/kubeconfig.js"

const ALPHA = `apiVersion: v1
kind: Config
current-context: alpha
contexts:
  - name: alpha
    context:
      cluster: cluster-a
      user: user-a
      namespace: ns-a
  - name: beta
    context:
      cluster: cluster-b
      user: user-b
`

const SECOND = `apiVersion: v1
kind: Config
contexts:
  - name: beta
    context:
      cluster: other-b
      user: other-b
  - name: gamma
    context:
      cluster: cluster-g
      user: user-g
`

function source(overrides: Partial<DiscoveredSource> & Pick<DiscoveredSource, "id" | "label">): DiscoveredSource {
  return {
    kind: "file",
    configId: overrides.id,
    available: true,
    contexts: [],
    ...overrides,
  }
}

test("parses contexts and current-context without retaining credentials", () => {
  const parsed = parseKubeconfig(ALPHA, "alpha")
  assert.equal(parsed.valid, true)
  assert.equal(parsed.currentContext, "alpha")
  assert.deepEqual(parsed.contexts.map((context) => context.name), ["alpha", "beta"])
  assert.deepEqual(parsed.contexts[0], {
    name: "alpha",
    cluster: "cluster-a",
    user: "user-a",
    namespace: "ns-a",
  })
})

test("rejects non-kubeconfig and malformed YAML", () => {
  assert.equal(parseKubeconfig("hello: world\n", "x").valid, false)
  assert.equal(parseKubeconfig("contexts: [", "x").valid, false)
  const parsed = parseKubeconfig("kind: Config\n", "empty")
  assert.equal(parsed.valid, true)
  assert.deepEqual(parsed.contexts, [])
})

test("deduplicates context names inside one file", () => {
  const parsed = parseKubeconfig(
    `kind: Config\ncontexts:\n  - name: same\n    context: {cluster: a}\n  - name: same\n    context: {cluster: b}\n`,
    "dup",
  )
  assert.equal(parsed.contexts.length, 1)
  assert.equal(parsed.contexts[0]!.cluster, "a")
})

test("merges enabled sources in order and the first definition wins", () => {
  const first = parseKubeconfig(ALPHA, "first")
  const second = parseKubeconfig(SECOND, "second")
  const sources = [
    source({ id: "first", label: "first", contexts: first.contexts, currentContext: first.currentContext }),
    source({ id: "second", label: "second", contexts: second.contexts }),
    source({ id: "off", label: "off", contexts: second.contexts }),
  ]

  const view = buildContextView(sources, new Set(["first", "second"]))
  assert.deepEqual(view.contexts.map((context) => context.name), ["alpha", "beta", "gamma"])
  assert.equal(view.currentContext, "alpha")
  assert.equal(view.currentSource, "first")

  const beta = view.contexts.find((context) => context.name === "beta")!
  assert.equal(beta.source, "first")
  assert.deepEqual(beta.alsoIn, ["second"])
  assert.equal(view.contexts.find((context) => context.name === "gamma")!.source, "second")

  const onlySecond = buildContextView(sources, new Set(["second"]))
  assert.deepEqual(onlySecond.contexts.map((context) => context.name), ["beta", "gamma"])
  assert.equal(onlySecond.currentContext, undefined)
})

test("a selected context overrides the file current-context", () => {
  const first = parseKubeconfig(ALPHA, "first")
  const sources = [source({ id: "first", label: "first", contexts: first.contexts, currentContext: "alpha" })]
  const view = buildContextView(sources, new Set(["first"]), "beta")
  assert.equal(view.currentContext, "beta")
  assert.equal(view.currentSourceLabel, "first")
})

test("expandSelection expands config ids over discovered directory files", () => {
  const sources = [
    source({ id: "default", label: "default" }),
    source({ id: "dir:configs:a.yaml", label: "configs/a.yaml", kind: "dir", configId: "configs" }),
    source({ id: "dir:configs:b.yaml", label: "configs/b.yaml", kind: "dir", configId: "configs" }),
  ]

  assert.deepEqual(expandSelection(["default", "configs"], sources), [
    "default",
    "dir:configs:a.yaml",
    "dir:configs:b.yaml",
  ])
  assert.deepEqual(expandSelection(["dir:configs:b.yaml", "missing"], sources), ["dir:configs:b.yaml"])
  assert.deepEqual(expandSelection([], sources), [])
})

test("selector stubs round-trip awkward context names", () => {
  const parsed = parseKubeconfig(selectorYaml('weird: "name" \\ prod'), "selector")
  assert.equal(parsed.valid, true)
  assert.equal(parsed.currentContext, 'weird: "name" \\ prod')
})

test("KUBECONFIG is a colon-separated list", () => {
  assert.equal(kubeconfigValue(["/a/selector.yaml", "/b/config"]), "/a/selector.yaml:/b/config")
})

test("secret store values decode from base64, base64: and raw YAML", () => {
  const encoded = Buffer.from(ALPHA, "utf8").toString("base64")
  assert.equal(decodeKubeconfigValue(encoded, "k8s/prod"), ALPHA)
  assert.equal(decodeKubeconfigValue(`base64:${encoded}`, "k8s/prod"), ALPHA)
  assert.equal(decodeKubeconfigValue(ALPHA, "k8s/prod"), ALPHA.trimEnd())
  assert.throws(() => decodeKubeconfigValue("not a kubeconfig", "k8s/prod"), /does not decode/)
  assert.equal(decodeKubeconfigValue(Buffer.from("kind: Config\n").toString("base64"), "e"), "kind: Config\n")
})
