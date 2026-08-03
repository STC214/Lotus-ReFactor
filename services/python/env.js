import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  resolveData,
  rootPath,
} from "../../core/path.js"
import { loadGlobalConfig } from "../../core/config/global.js"
import { formatLocalIso } from "../../core/time.js"
import { detectPythonEnvironment } from "../runtime/environment.js"

export class PythonEnvService {
  constructor(options = {}) {
    this.config = options.config
    this.spawn = options.spawn || spawn
    this.fetch = options.fetch || globalThis.fetch
    this.onProgress = options.onProgress
  }

  async getConfig() {
    if (this.config) return this.config
    const globalConfig = await loadGlobalConfig()
    return globalConfig.python || {}
  }

  async getPythonExecutable() {
    const config = await this.getConfig()
    if (config.mode === "system") {
      const detected = await this.detectSystemPython(config)
      return { ...detected, mode: "system" }
    }

    const venvPath = resolveMaybeData(config.venv_path || "data/python/venv")
    const executable = process.platform === "win32"
      ? path.join(venvPath, "Scripts", "python.exe")
      : path.join(venvPath, "bin", "python")
    const detected = await detectPythonEnvironment({
      configured: executable,
      includeDefaults: false,
      minimumVersion: config.minimum_version || "3.10",
      spawn: this.spawn,
    })
    return {
      ...detected,
      mode: "venv",
      venvPath,
    }
  }

  async ensureVenv(options = {}) {
    const { installRequirements = true } = options
    const onProgress = options.onProgress || this.onProgress
    const config = await this.getConfig()
    if (config.mode === "system") return this.getPythonExecutable()

    const venvPath = resolveMaybeData(config.venv_path || "data/python/venv")
    const pyvenv = path.join(venvPath, "pyvenv.cfg")
    try {
      await fs.access(pyvenv)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      const systemPython = await this.detectSystemPython(config)
      await emitProgress(onProgress, `Python：创建虚拟环境 ${venvPath}`)
      await emitProgress(onProgress, `Python：使用 ${systemPython.executable} (${systemPython.version}, ${systemPython.platform}/${systemPython.arch})`)
      await createPythonVenv({
        spawnImpl: this.spawn,
        systemPython,
        venvPath,
        cwd: rootPath,
        onProgress,
      })
      await emitProgress(onProgress, "Python：虚拟环境创建完成")
    }

    const python = await this.getPythonExecutable()
    if (installRequirements) {
      await ensurePythonPip({
        python,
        spawnImpl: this.spawn,
        fetchImpl: this.fetch,
        onProgress,
      })
    }
    await emitProgress(onProgress, "MihoyoBBSTools：检查依赖指纹")
    const status = await this.getFingerprintStatus(venvPath)
    if (installRequirements && status.stale) {
      await emitProgress(onProgress, `MihoyoBBSTools：安装 Python 依赖（${status.reasons.join(", ") || "首次初始化"}）`)
      await runProcess(this.spawn, python.command, [
        ...(python.args || []),
        "-m",
        "pip",
        "install",
        "-r",
        path.join(rootPath, "MihoyoBBSTools", "requirements.txt"),
      ], {
        cwd: rootPath,
      })
      await emitProgress(onProgress, "MihoyoBBSTools：Python 依赖安装完成")
    } else if (installRequirements) {
      await emitProgress(onProgress, "MihoyoBBSTools：Python 依赖未变化")
    }

    if (installRequirements) await this.writeFingerprint(venvPath, status.current)
    return {
      ...python,
      fingerprint: status.current,
      fingerprintStale: status.stale,
      fingerprintReasons: status.reasons,
    }
  }

  async detectSystemPython(config = null) {
    const normalized = config || await this.getConfig()
    return detectPythonEnvironment({
      configured: normalized.system_python,
      minimumVersion: normalized.minimum_version || "3.10",
      spawn: this.spawn,
    })
  }

  async getFingerprintStatus(venvPath) {
    const current = await this.buildFingerprint()
    const file = path.join(venvPath, "lotus-fingerprint.json")
    let saved = null
    try {
      saved = JSON.parse(await fs.readFile(file, "utf8"))
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    return diffFingerprint(saved, current)
  }

  async buildFingerprint() {
    const requirements = path.join(rootPath, "MihoyoBBSTools", "requirements.txt")
    const raw = await fs.readFile(requirements, "utf8")
    const commit = await this.readBbsToolsCommit()
    return {
      requirements_sha256: createHash("sha256").update(raw).digest("hex"),
      bbstools_commit: commit,
      python_environment: await this.pythonFingerprint(),
    }
  }

  async pythonFingerprint() {
    try {
      const python = await this.detectSystemPython()
      return `${python.implementation || "Python"}-${python.version}-${python.platform}-${python.arch}`
    } catch {
      return "unavailable"
    }
  }

  async writeFingerprint(venvPath, fingerprint = null) {
    const current = fingerprint || await this.buildFingerprint()
    const data = {
      ...current,
      updated_at: formatLocalIso(),
    }
    const file = path.join(venvPath, "lotus-fingerprint.json")
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8")
    return data
  }

  async readBbsToolsCommit() {
    try {
      const result = await runProcess(this.spawn, "git", [
        "-C",
        path.join(rootPath, "MihoyoBBSTools"),
        "rev-parse",
        "HEAD",
      ], {
        cwd: rootPath,
      })
      return result.stdout.trim()
    } catch {
      return ""
    }
  }
}

export async function ensurePythonPip(options = {}) {
  const python = options.python || {}
  const command = python.command || python.executable || python
  const args = [...(python.args || [])]
  const spawnImpl = options.spawnImpl || spawn
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const cwd = options.cwd || rootPath
  const pipArgs = [...args, "-m", "pip", "--version"]
  try {
    const result = await runProcess(spawnImpl, command, pipArgs, { cwd })
    return { ok: true, status: "available", version: result.stdout.trim() }
  } catch {}

  await emitProgress(options.onProgress, "Python：虚拟环境缺少 pip，尝试 ensurepip")
  try {
    await runProcess(spawnImpl, command, [...args, "-m", "ensurepip", "--upgrade"], { cwd })
  } catch (ensureError) {
    if (typeof fetchImpl !== "function") {
      const error = new Error(`pip bootstrap unavailable: ${processErrorDetail(ensureError)}`)
      error.code = "PIP_BOOTSTRAP_UNAVAILABLE"
      error.cause = ensureError
      throw error
    }
    await emitProgress(options.onProgress, "Python：ensurepip 不可用，按 PyPA 官方方式下载 get-pip.py")
    const response = await fetchImpl("https://bootstrap.pypa.io/get-pip.py", {
      headers: { "User-Agent": "Lotus-Plugin pip bootstrap" },
    })
    if (!response?.ok) throw new Error(`download get-pip.py failed: HTTP ${response?.status || "unknown"}`)
    const tempDir = resolveData("tmp", "pip-bootstrap")
    const script = path.join(tempDir, `get-pip-${process.pid}-${Date.now()}.py`)
    await fs.mkdir(tempDir, { recursive: true })
    try {
      await fs.writeFile(script, Buffer.from(await response.arrayBuffer()))
      await runProcess(spawnImpl, command, [...args, script, "--disable-pip-version-check"], { cwd })
    } finally {
      await fs.rm(script, { force: true }).catch(() => {})
    }
  }

  const result = await runProcess(spawnImpl, command, pipArgs, { cwd })
  await emitProgress(options.onProgress, "Python：pip 已就绪")
  return { ok: true, status: "bootstrapped", version: result.stdout.trim() }
}

export async function createPythonVenv(options = {}) {
  const systemPython = options.systemPython || {}
  const command = systemPython.command || systemPython.executable || systemPython
  const args = [...(systemPython.args || [])]
  const spawnImpl = options.spawnImpl || spawn
  const cwd = options.cwd || rootPath
  try {
    await runProcess(spawnImpl, command, [...args, "-m", "venv", options.venvPath], { cwd })
    return { ok: true, withoutPip: false }
  } catch (error) {
    const detail = processErrorDetail(error)
    if (!/ensurepip|python\S*-venv|venv package/i.test(detail)) throw error
    await emitProgress(options.onProgress, "Python：系统 venv 缺少 ensurepip，改用 --without-pip 创建")
    await fs.rm(options.venvPath, { recursive: true, force: true })
    await runProcess(spawnImpl, command, [...args, "-m", "venv", "--without-pip", options.venvPath], { cwd })
    return { ok: true, withoutPip: true }
  }
}

async function emitProgress(onProgress, message) {
  if (typeof onProgress !== "function") return
  try {
    await onProgress(message)
  } catch (error) {
    logger?.debug?.(`[Lotus-Plugin] progress callback failed: ${error.message}`)
  }
}

export function diffFingerprint(saved, current) {
  if (!saved) {
    const fingerprint = {
      current,
      saved: null,
      stale: true,
      reasons: ["missing"],
    }
    return fingerprint
  }

  const reasons = []
  if (saved.requirements_sha256 !== current.requirements_sha256) reasons.push("requirements")
  if ((saved.bbstools_commit || "") !== (current.bbstools_commit || "")) reasons.push("bbstools_commit")
  if ((saved.python_environment || "") !== (current.python_environment || "")) reasons.push("python_environment")

  return {
    current,
    saved,
    stale: reasons.length > 0,
    reasons,
  }
}

export function runProcess(spawnImpl, command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd: options.cwd || rootPath,
      env: withUtf8ProcessEnv(options.env || process.env),
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", chunk => {
      stdout += decodeProcessChunk(chunk)
    })
    child.stderr?.on("data", chunk => {
      stderr += decodeProcessChunk(chunk)
    })
    child.on("error", reject)
    child.on("close", code => {
      if (code === 0) {
        resolve({ code, stdout, stderr })
        return
      }
      const detail = (stderr || stdout).trim()
      const error = new Error(`${command} exited with code ${code}${detail ? `: ${detail.slice(-500)}` : ""}`)
      error.code = code
      error.stdout = stdout
      error.stderr = stderr
      reject(error)
    })
  })
}

function processErrorDetail(error) {
  return String(error?.stderr || error?.stdout || error?.message || error || "unknown error").trim().slice(-500)
}

export function withUtf8ProcessEnv(env = process.env) {
  return {
    ...env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    PYTHONLEGACYWINDOWSSTDIO: "0",
  }
}

export function decodeProcessChunk(chunk) {
  if (chunk == null) return ""
  if (typeof chunk === "string") return chunk
  return new TextDecoder("utf-8", { fatal: false }).decode(chunk)
}

function resolveMaybeData(value) {
  if (path.isAbsolute(value)) return value
  if (value.startsWith("data/") || value.startsWith("data\\")) {
    return resolveData(value.slice(5))
  }
  return path.join(rootPath, value)
}
