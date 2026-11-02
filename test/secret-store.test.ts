import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { decodeKubeconfigValue } from "../src/kubeconfig.js"
import { SecretStore, parseSecretFile } from "../src/secret-store.js"

const hasAge = (() => {
  try {
    execFileSync("age", ["--version"], { stdio: "ignore" })
    execFileSync("age-keygen", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const KUBECONFIG = `apiVersion: v1
kind: Config
current-context: secret-store-test
contexts:
  - name: secret-store-test
    context:
      cluster: secret-store-test
      user: secret-store-test
`

test("parses quoted, escaped and literal secret store values", () => {
  const parsed = parseSecretFile(
    [
      "# comment",
      "PLAIN=value with spaces",
      'QUOTED="line\\nbreak"',
      "SINGLE='literal $NOT_EXPANDED'",
      "EXPORTED=exported-value",
      "bad line",
    ].join("\n"),
  )
  assert.equal(parsed.values.PLAIN, "value with spaces")
  assert.equal(parsed.values.QUOTED, "line\nbreak")
  assert.equal(parsed.values.SINGLE, "literal $NOT_EXPANDED")
  assert.equal(parsed.values.EXPORTED, "exported-value")
  assert.equal(parsed.warnings.length, 1)
})

test("decrypts a layered age store and resolves one entry", { skip: !hasAge }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "k8s-secret-store-"))
  try {
    const keyFile = path.join(directory, "keys.txt")
    execFileSync("age-keygen", ["-o", keyFile], { stdio: "ignore" })
    const publicKey = execFileSync("age-keygen", ["-y", keyFile], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    const recipient = publicKey.match(/age1[0-9a-z]+/)?.[0]
    assert.ok(recipient, `could not read age public key from: ${publicKey}`)

    const plain = path.join(directory, "plain.env")
    fs.writeFileSync(
      plain,
      `K8S_TEST=${Buffer.from(KUBECONFIG, "utf8").toString("base64")}\nOTHER=not-a-kubeconfig\n`,
      { mode: 0o600 },
    )
    const store = path.join(directory, "secrets.age")
    execFileSync("age", ["-e", "-r", recipient, "-o", store, plain])

    const store_ = new SecretStore(directory, async () => ({
      layers: [{ type: "local-age", provider: [], store, keyFile }],
      ttlSeconds: 0,
      warnings: [],
    }))

    const entry = await store_.entry("K8S_TEST")
    assert.ok(entry)
    assert.equal(decodeKubeconfigValue(entry!.value, "K8S_TEST").trimEnd(), KUBECONFIG.trimEnd())
    assert.equal(await store_.entry("MISSING"), undefined)

    const listing = await store_.list()
    assert.deepEqual(listing.entries, ["K8S_TEST", "OTHER"])
    assert.deepEqual(listing.errors, [])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
