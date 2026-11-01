// Builds src/tui.tsx into ./tui.js for GitHub/npm installs, which resolve the
// package exports map instead of loading the source through OpenCode's own
// runtime.
//
// The server part stays as TypeScript: OpenCode loads server entries itself and
// strips types. The TUI part cannot rely on that, because Bun's built-in JSX
// lowering uses React semantics and would break Solid's universal renderer.
// Babel with babel-preset-solid (generate: "universal") performs the correct
// lowering here, then esbuild bundles the result.
import { build } from "esbuild"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import presetSolid from "babel-preset-solid"
import path from "node:path"

const root = path.dirname(new URL(import.meta.url).pathname)

/** Resolve relative `./x.js` imports written in TypeScript sources. */
const resolveTsExtension = {
  name: "resolve-ts-extension",
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, async (args) => {
      for (const candidate of [args.path.replace(/\.js$/, ".ts"), args.path.replace(/\.js$/, ".tsx")]) {
        try {
          const resolved = await build.resolve(candidate, {
            kind: args.kind,
            resolveDir: args.resolveDir,
          })
          if (resolved.path) return { path: resolved.path }
        } catch {
          // Try the next candidate.
        }
      }
      return undefined
    })
  },
}

const solidTransform = {
  name: "solid-transform",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const { readFile } = await import("node:fs/promises")
      const code = await readFile(args.path, "utf8")
      const transformed = await transformAsync(code, {
        filename: args.path,
        configFile: false,
        babelrc: false,
        presets: [
          [presetSolid, { moduleName: "@opentui/solid", generate: "universal" }],
          [presetTypescript, { isTSX: true, allExtensions: true }],
        ],
      })
      return { contents: transformed?.code ?? "", loader: "js", resolveDir: path.dirname(args.path) }
    })
  },
}

const result = await build({
  entryPoints: [path.join(root, "src/tui.tsx")],
  outfile: path.join(root, "tui.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  packages: "external",
  tsconfig: path.join(root, "tsconfig.build.json"),
  plugins: [resolveTsExtension, solidTransform],
  logLevel: "info",
})

if (result.errors.length) process.exit(1)

const code = await (await import("node:fs/promises")).readFile(path.join(root, "tui.js"), "utf8")
for (const marker of ["jsxDEV", "jsx-runtime", "React.createElement"]) {
  if (code.includes(marker)) {
    console.error(`FAILED: output contains "${marker}"; the Solid transform did not run`)
    process.exit(1)
  }
}
console.log(`built tui.js (${code.length} bytes)`)
