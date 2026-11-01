import { build } from "esbuild"
import path from "node:path"

const root = path.dirname(new URL(import.meta.url).pathname)

const resolveTsExtension = {
  name: "resolve-ts-extension",
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, async (args) => {
      for (const candidate of [args.path.replace(/\.js$/, ".ts"), args.path.replace(/\.js$/, ".tsx")]) {
        try {
          const resolved = await build.resolve(candidate, { kind: args.kind, resolveDir: args.resolveDir })
          if (resolved.path) return { path: resolved.path }
        } catch {
          // Try the next candidate.
        }
      }
      return undefined
    })
  },
}

await build({
  entryPoints: [
    path.join(root, "test/kubeconfig.test.ts"),
    path.join(root, "test/config.test.ts"),
    path.join(root, "test/vault.test.ts"),
  ],
  outdir: path.join(root, ".test-build"),
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  plugins: [resolveTsExtension],
  logLevel: "error",
})

console.log("built tests")
