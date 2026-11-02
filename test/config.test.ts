import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { defaultConfig, loadConfig, normalizeConfig, sourceLabel } from "../src/config.js"

test("defaults include ~/.kube/config and a disabled directory", () => {
  const config = defaultConfig()
  assert.deepEqual(config.defaultEnabled, ["default"])
  assert.equal(config.sources[0]!.path, "~/.kube/config")
  assert.ok(config.sources.some((source) => source.kind === "dir"))
  assert.equal(config.secretStore.inherit, true)
})

test("normalizeConfig drops invalid sources and reports why", () => {
  const warnings: string[] = []
  const config = normalizeConfig(
    {
      sources: [
        { id: "good", kind: "file", path: "~/.kube/config" },
        { id: "bad id", kind: "file", path: "/tmp/x" },
        { id: "nostore", kind: "secret-store" },
        { id: "nopath", kind: "file" },
      ],
      defaultEnabled: ["good", "missing"],
      profileLinks: { prod: ["good"], empty: [] },
    },
    warnings,
  )
  assert.deepEqual(config.sources.map((source) => source.id), ["good"])
  assert.deepEqual(config.defaultEnabled, ["good", "missing"])
  assert.deepEqual(config.profileLinks, { prod: ["good"] })
  assert.equal(warnings.length, 3)
})

test("the pre-rename source kind and config key are still accepted", () => {
  const warnings: string[] = []
  const config = normalizeConfig(
    {
      sources: [
        { id: "legacy", kind: "vault", entry: "k8s/prod" },
        { id: "current", kind: "secret-store", entry: "k8s/dev" },
      ],
      vault: { inherit: false, stores: [{ store: "~/.config/age/secrets.age", keyFile: "~/.config/age/keys.txt" }] },
    },
    warnings,
  )
  assert.deepEqual(warnings, [])
  assert.deepEqual(config.sources.map((source) => source.kind), ["secret-store", "secret-store"])
  assert.equal(config.secretStore.inherit, false)
  assert.equal(config.secretStore.stores.length, 1)
  assert.equal(config.secretStore.stores[0]!.type, "local-age")
})

test("a layer with an argv provider is a custom provider", () => {
  const config = normalizeConfig(
    { secretStore: { stores: [{ provider: ["gpg", "--decrypt", "{store}"], store: "~/.secrets/vault.gpg" }] } },
    [],
  )
  assert.equal(config.secretStore.stores[0]!.type, "custom")
  assert.equal(config.secretStore.stores[0]!.provider.length, 3)
})

test("sourceLabel prefers the explicit label", () => {
  assert.equal(sourceLabel({ id: "x", kind: "file", path: "/home/me/.kube/config" }), "config")
  assert.equal(sourceLabel({ id: "x", kind: "secret-store", entry: "k8s/prod", label: "prod" }), "prod")
  assert.equal(sourceLabel({ id: "x", kind: "secret-store", entry: "k8s/prod" }), "k8s/prod")
})

test("a global-only config keeps its own defaults", async () => {
  const previous = process.env.XDG_CONFIG_HOME
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "k8s-config-"))
  try {
    process.env.XDG_CONFIG_HOME = path.join(root, "config")
    fs.mkdirSync(path.join(root, "config", "opencode"), { recursive: true })
    fs.writeFileSync(
      path.join(root, "config", "opencode", "k8s-manager.json"),
      JSON.stringify({
        sources: [{ id: "global-config", kind: "file", path: "/tmp/global-kubeconfig" }],
        defaultEnabled: ["global-config"],
        profileLinks: { prod: ["global-config"] },
      }),
    )
    const project = path.join(root, "project")
    fs.mkdirSync(project)
    const loaded = await loadConfig(project)
    assert.equal(loaded.path, path.join(root, "config", "opencode", "k8s-manager.json"))
    assert.deepEqual(loaded.config.sources.map((source) => source.id), ["global-config"])
    assert.deepEqual(loaded.config.defaultEnabled, ["global-config"])
    assert.deepEqual(loaded.config.profileLinks["prod"], ["global-config"])
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
