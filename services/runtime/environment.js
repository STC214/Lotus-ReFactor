import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"

const PYTHON_PROBE = "import json,platform,sys;print(json.dumps({'executable':sys.executable,'version':platform.python_version(),'implementation':platform.python_implementation(),'platform':sys.platform,'machine':platform.machine(),'prefix':sys.prefix,'base_prefix':getattr(sys,'base_prefix',sys.prefix)}))"

export function normalizePlatform(platform = process.platform) {
  const value = String(platform || "").toLowerCase()
  if (["win32", "windows", "win"].includes(value)) return "windows"
  if (["darwin", "mac", "macos", "osx"].includes(value)) return "darwin"
  if (value === "android") return "android"
  if (value === "freebsd") return "freebsd"
  return "linux"
}

export function normalizeArch(arch = process.arch) {
  const value = String(arch || "").toLowerCase()
  if (["x64", "amd64", "x86_64"].includes(value)) return "x64"
  if (["arm64", "aarch64"].includes(value)) return "arm64"
  if (["ia32", "x86", "i386", "i686"].includes(value)) return "x86"
  if (["arm", "armv7", "armv7l"].includes(value)) return "armv7"
  return value || "unknown"
}

export function detectLibc(report = process.report, platform = process.platform) {
  if (normalizePlatform(platform) !== "linux") return "none"
  try {
    const header = typeof report?.getReport === "function" ? report.getReport()?.header : report?.header
    if (header?.glibcVersionRuntime || header?.glibcVersionCompiler) return "glibc"
  } catch {}
  return "musl"
}

export function detectRuntimeEnvironment(options = {}) {
  const platform = normalizePlatform(options.platform || process.platform)
  const arch = normalizeArch(options.arch || process.arch)
  const libc = options.libc || detectLibc(options.report || process.report, platform)
  return {
    platform,
    arch,
    libc,
    key: [platform, arch, platform === "linux" ? libc : ""].filter(Boolean).join("-"),
    node: process.version,
  }
}

export function pythonCandidates(options = {}) {
  const platform = normalizePlatform(options.platform || process.platform)
  const configured = String(options.configured || "").trim()
  const candidates = []
  const add = (command, args = [], source = "auto") => {
    if (!command) return
    const key = `${command}\0${args.join("\0")}`
    if (!candidates.some(item => item.key === key)) candidates.push({ command, args, source, key })
  }
  if (configured && configured.toLowerCase() !== "auto") add(configured, [], "configured")
  if (options.includeDefaults !== false) {
    if (platform === "windows") {
      add("py", ["-3"], "launcher")
      add("python", [], "path")
      add("python3", [], "path")
    } else {
      add("python3", [], "path")
      add("python", [], "path")
    }
  }
  return candidates.map(({ key, ...item }) => item)
}

export async function detectPythonEnvironment(options = {}) {
  const spawnImpl = options.spawn || spawn
  const minimum = parseVersion(options.minimumVersion || "3.10")
  const attempts = []
  for (const candidate of pythonCandidates(options)) {
    try {
      const result = await runCommand(spawnImpl, candidate.command, [
        ...candidate.args,
        "-c",
        PYTHON_PROBE,
      ], { timeoutMs: options.timeoutMs || 15000 })
      const info = JSON.parse(lastJsonLine(result.stdout))
      const version = parseVersion(info.version)
      if (compareVersion(version, minimum) < 0) {
        attempts.push({ ...candidate, ok: false, reason: `Python ${info.version} < ${minimum.join(".")}` })
        continue
      }
      return {
        ok: true,
        command: candidate.command,
        args: candidate.args,
        source: candidate.source,
        executable: info.executable || candidate.command,
        version: info.version,
        implementation: info.implementation,
        platform: normalizePlatform(info.platform),
        arch: normalizeArch(info.machine),
        isVenv: info.prefix !== info.base_prefix,
        attempts,
      }
    } catch (error) {
      attempts.push({ ...candidate, ok: false, reason: error.code === "ENOENT" ? "not_found" : error.message })
    }
  }
  const detail = attempts.map(item => `${item.command}${item.args.length ? ` ${item.args.join(" ")}` : ""}: ${item.reason}`).join("; ")
  const error = new Error(`未找到 Python ${minimum.join(".")}+：${detail || "没有候选命令"}`)
  error.code = "PYTHON_NOT_FOUND"
  error.attempts = attempts
  throw error
}

export async function findExecutableOnPath(command, options = {}) {
  const platform = normalizePlatform(options.platform || process.platform)
  const env = options.env || process.env
  if (!command) return ""
  if (path.isAbsolute(command)) return await isFile(command) ? command : ""
  const pathValue = env.PATH || env.Path || env.path || ""
  const extensions = platform === "windows"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""]
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    const names = platform === "windows" && path.extname(command)
      ? [command]
      : extensions.map(ext => `${command}${ext}`)
    for (const name of names) {
      const target = path.join(dir.replace(/^"|"$/g, ""), name)
      if (await isFile(target)) return target
    }
  }
  return ""
}

export function environmentKeys(environment = detectRuntimeEnvironment()) {
  const { platform, arch, libc } = environment
  return [
    platform === "linux" ? `${platform}-${arch}-${libc}` : "",
    `${platform}-${arch}`,
    platform,
    "default",
  ].filter(Boolean)
}

export function selectEnvironmentValue(values, environment = detectRuntimeEnvironment()) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return ""
  for (const key of environmentKeys(environment)) {
    const value = values[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

export function runCommand(spawnImpl, command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      child.kill?.("SIGTERM")
      const error = new Error(`${command} timed out`)
      error.code = "ETIMEDOUT"
      finish(reject, error)
    }, Number(options.timeoutMs || 15000))
    child.stdout?.on("data", chunk => { stdout += chunk.toString() })
    child.stderr?.on("data", chunk => { stderr += chunk.toString() })
    child.on("error", error => finish(reject, error))
    child.on("close", code => {
      if (code === 0) return finish(resolve, { code, stdout, stderr })
      const error = new Error((stderr || stdout || `${command} exited with code ${code}`).trim())
      error.code = code
      error.stdout = stdout
      error.stderr = stderr
      finish(reject, error)
    })
  })
}

function lastJsonLine(value = "") {
  return String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || "{}"
}

function parseVersion(value = "0") {
  const parts = String(value).match(/\d+/g)?.slice(0, 3).map(Number) || [0]
  while (parts.length < 3) parts.push(0)
  return parts
}

function compareVersion(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0)
    if (diff) return diff
  }
  return 0
}

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}
