import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Expand ~, $HOME and relative paths against the work directory. */
export function expandPath(value: string, directory: string): string {
  const trimmed = value.trim()
  if (trimmed === "~") return os.homedir()
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2))
  if (trimmed.startsWith("$HOME/")) return path.join(os.homedir(), trimmed.slice(6))
  if (path.isAbsolute(trimmed)) return trimmed
  return path.resolve(directory, trimmed)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Private directory for generated selector and vault kubeconfig files. */
export function stateDirectory(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(base, "opencode", "k8s")
}

export async function ensurePrivateDir(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700).catch(() => undefined)
  return directory
}

export async function writePrivateFile(file: string, content: string): Promise<string> {
  await ensurePrivateDir(path.dirname(file))
  await fs.writeFile(file, content, { encoding: "utf8", mode: 0o600 })
  await fs.chmod(file, 0o600).catch(() => undefined)
  return file
}

export function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "k8s"
}

export async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

export async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(directory)).isDirectory()
  } catch {
    return false
  }
}
