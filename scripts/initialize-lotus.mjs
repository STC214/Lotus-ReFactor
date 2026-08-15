#!/usr/bin/env node

import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { createHash, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

const scriptRoot = path.dirname(fileURLToPath(import.meta.url))
export const pluginRoot = path.resolve(scriptRoot, "..")
export const yunzaiRoot = path.resolve(pluginRoot, "../..")

export const SUBMODULE_SOURCES = {
  MihoyoBBSTools: "https://github.com/Womsxd/MihoyoBBSTools.git",
  test_nine: "https://github.com/luguoyixiazi/test_nine.git",
  "nanoka-atlas-backend": "https://github.com/MOPELotus/nanoka-atlas-backend.git",
}

export const DEPENDENCY_ENDPOINTS = [
  { name: "GitHub", url: "https://github.com/" },
  { name: "GitHub API", url: "https://api.github.com/" },
  { name: "GitHub Raw", url: "https://raw.githubusercontent.com/" },
  { name: "GitHub Objects", url: "https://objects.githubusercontent.com/" },
  { name: "Gitee", url: "https://gitee.com/" },
  { name: "PyPI", url: "https://pypi.org/simple/pip/" },
  { name: "Python Files", url: "https://files.pythonhosted.org/" },
  { name: "npm Registry", url: "https://registry.npmjs.org/skia-canvas" },
]

export async function probeDependencyNetwork(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeoutMs = Number(options.timeoutMs || 8000)
  return Promise.all((options.endpoints || DEPENDENCY_ENDPOINTS).map(async endpoint => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = performance.now()
    try {
      const response = await fetchImpl(endpoint.url, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": "Lotus-Plugin-Initializer/1.0" },
      })
      return {
        ...endpoint,
        ok: response.ok || (response.status >= 300 && response.status < 500),
        status: response.status,
        latencyMs: Math.max(1, Math.round(performance.now() - started)),
      }
    } catch (error) {
      return {
        ...endpoint,
        ok: false,
        status: 0,
        latencyMs: Math.max(1, Math.round(performance.now() - started)),
        reason: error.name === "AbortError" ? "timeout" : error.message,
      }
    } finally {
      clearTimeout(timer)
    }
  }))
}

export function formatNetworkReport(items = []) {
  const lines = items.map(item => `${item.ok ? "✓" : "✗"} ${item.name}：${item.ok ? `${item.latencyMs} ms` : `${item.reason || `HTTP ${item.status}`}（${item.latencyMs} ms）`}`)
  const reachable = items.some(item => item.ok)
  return [
    "[荷花插件]依赖网络检测（HTTP Ping）：",
    ...lines,
    reachable
      ? "请确认已经挂好“魔法网络”。部分站点延迟过高或连接失败时，后续对应下载可能超时；初始化将继续并逐项反馈结果。"
      : "所有依赖站点均连接失败。初始化已在修改文件和安装依赖前停止；请检查网络后重新执行。",
  ].join("\n")
}

export function buildInitializationSummaryItems(bootstrapResults = [], runtimeResults = [], options = {}) {
  return [
    ...[...bootstrapResults, ...runtimeResults].map(item => ({
      label: item.name,
      value: `${item.ok ? "成功" : "失败"} · ${item.value || item.reason || "-"}`,
    })),
    { label: "账号配置", value: "接下来为每个账号执行 #扫码登录、#注册自动签到、#启用全部游戏签到、#同步角色、#测试签到" },
    { label: "重启", value: options.restartRecommended ? "工作区或锅巴发生变化，初始化结果返回后执行 #重启" : "本次无需因初始化额外重启" },
  ]
}

export function mergeWorkspacePolicy(source) {
  let lines = String(source || "").replace(/\r\n/g, "\n").split("\n")
  lines = mergeMappingBlock(lines, "allowBuilds", {
    "skia-canvas": "true",
    protobufjs: "false",
  })
  lines = mergeSequenceBlock(lines, "onlyBuiltDependencies", ["skia-canvas"])
  return `${lines.join("\n").replace(/\n+$/, "")}\n`
}

export async function runLotusBootstrap(options = {}) {
  const onEvent = options.onEvent || (() => {})
  const roots = {
    plugin: path.resolve(options.pluginRoot || pluginRoot),
    yunzai: path.resolve(options.yunzaiRoot || yunzaiRoot),
  }
  const results = []

  const network = await probeDependencyNetwork(options.network || {})
  await emit(onEvent, { type: "network", items: network })
  const networkResult = {
    name: "依赖网络",
    ok: network.some(item => item.ok),
    critical: true,
    value: `${network.filter(item => item.ok).length}/${network.length} 可连接`,
    detail: network,
  }
  results.push(networkResult)
  if (!networkResult.ok) {
    return {
      ok: false,
      roots,
      network,
      results,
      restartRecommended: false,
    }
  }

  const stages = [
    ["保存基线", () => preserveBaseline(roots, options)],
    ["系统组件", () => ensureSystemPackages(options)],
    ["锅巴插件", () => ensureGuoba(roots, options)],
    ["Git 子模块", () => ensureSubmodules(roots, options)],
    ["pnpm 构建策略", () => ensureWorkspacePolicy(roots)],
    ["更新持久化保护", () => ensureUpdatePersistence(roots, options)],
    ["Node 依赖", () => ensureNodeDependencies(roots, options)],
    ["skia-canvas", () => ensureSkiaCanvas(roots, options)],
    ["基础验收", () => verifyBootstrap(roots, options)],
  ]
  for (const [name, task] of stages) {
    const item = await step(results, onEvent, name, task, { critical: true })
    if (!item.ok) break
  }

  return {
    ok: results.filter(item => item.critical !== false).every(item => item.ok),
    roots,
    network,
    results,
    restartRecommended: results.some(item => item.changed),
  }
}

async function preserveBaseline(roots, options = {}) {
  const pluginRelative = relativeInside(roots.yunzai, roots.plugin)
  const stamp = localStamp()
  const backupRoot = path.join(roots.plugin, "data", "initialization", "backups", stamp)
  const stagingRoot = `${backupRoot}.partial-${randomUUID()}`
  await fs.mkdir(path.dirname(backupRoot), { recursive: true })
  await fs.mkdir(stagingRoot, { recursive: true })
  try {
    const git = await resolveGitLayout(roots, options)
    const trackedFiles = [
      { relative: "pnpm-workspace.yaml", target: path.join(roots.yunzai, "pnpm-workspace.yaml") },
      { relative: "pnpm-lock.yaml", target: path.join(roots.yunzai, "pnpm-lock.yaml") },
      ...(git ? [
        { relative: ".git/hooks/post-checkout", backupKey: "git/hooks/post-checkout", target: path.join(git.hooksRoot, "post-checkout") },
        { relative: ".git/hooks/post-merge", backupKey: "git/hooks/post-merge", target: path.join(git.hooksRoot, "post-merge") },
        { relative: ".git/lotus-workspace-policy.log", backupKey: "git/lotus-workspace-policy.log", target: path.join(git.gitDir, "lotus-workspace-policy.log") },
        { relative: ".git/lotus-workspace-policy.status.json", backupKey: "git/lotus-workspace-policy.status.json", target: path.join(git.gitDir, "lotus-workspace-policy.status.json") },
      ] : []),
    ]
    const files = []
    for (const { relative, target: source, backupKey = relative } of trackedFiles) {
      const existed = await exists(source)
      const stat = existed ? await fs.stat(source) : null
      if (stat && !stat.isFile()) throw new Error(`基线文件不是普通文件：${source}`)
      files.push({ relative, target: source, backupKey, existed, mode: stat?.mode ?? null })
      if (existed) await copyWithParents(source, path.join(stagingRoot, "files", ...backupKey.split("/")))
    }
    const managedDirectories = [
      { relative: "plugins/Guoba-Plugin", restoreGit: false },
      ...Object.keys(SUBMODULE_SOURCES).map(name => ({ relative: path.join(pluginRelative, name).replace(/\\/g, "/"), restoreGit: true })),
    ]
    const directories = []
    for (const { relative, restoreGit } of managedDirectories) {
      const target = path.join(roots.yunzai, ...relative.split("/"))
      const git = restoreGit ? await readGitState(target) : null
      directories.push({ relative, existed: await exists(target), restoreGit, ...git })
    }
    const manifest = {
      createdAt: new Date().toISOString(),
      pluginRoot: roots.plugin,
      yunzaiRoot: roots.yunzai,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      files,
      directories,
    }
    await fs.writeFile(path.join(stagingRoot, "baseline.json"), JSON.stringify(manifest, null, 2) + "\n")
    await fs.writeFile(path.join(stagingRoot, "rollback.mjs"), rollbackSource(), "utf8")
    await fs.rename(stagingRoot, backupRoot)
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return { ok: true, value: `${backupRoot}（回滚：node rollback.mjs）` }
}

async function ensureSystemPackages(options = {}) {
  const required = ["git", "python3", "ffmpeg", "ffprobe", "aria2c", "zip", "unzip"]
  const missing = []
  for (const command of required) {
    if (!await commandExists(command, options)) missing.push(command)
  }
  if (!missing.length) return { ok: true, value: "git/python/ffmpeg/aria2/zip 已存在" }
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0 || !await commandExists("apt-get", options)) {
    return { ok: false, value: `缺少 ${missing.join(", ")}；当前环境不满足自动 apt 安装条件` }
  }
  await run("apt-get", ["update"], { ...options, timeoutMs: 20 * 60_000 })
  await run("apt-get", ["install", "-y", "--no-install-recommends", "git", "ca-certificates", "python3", "python3-venv", "ffmpeg", "aria2", "zip", "unzip"], {
    ...options,
    env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
    timeoutMs: 20 * 60_000,
  })
  return { ok: true, changed: true, value: `已补装：${missing.join(", ")}` }
}

async function ensureGuoba(roots, options = {}) {
  const target = path.join(roots.yunzai, "plugins", "Guoba-Plugin")
  if (await exists(path.join(target, "package.json"))) return { ok: true, value: "已安装" }
  if (await exists(target)) return { ok: false, value: `${target} 已存在但不是完整锅巴插件目录` }
  await run("git", ["clone", "https://gitee.com/guoba-yunzai/guoba-plugin.git", target], { ...options, timeoutMs: 10 * 60_000 })
  return { ok: true, changed: true, value: target }
}

export async function ensureSubmodules(roots, options = {}) {
  if (await exists(path.join(roots.plugin, ".git"))) {
    for (const name of Object.keys(SUBMODULE_SOURCES)) {
      const state = await readGitState(path.join(roots.plugin, name))
      if (state?.dirty) throw new Error(`${name} 存在未提交改动；为保护工作树，已停止自动更新`)
    }
    await run("git", ["submodule", "sync", "--recursive"], { ...options, cwd: roots.plugin })
    await run("git", ["submodule", "update", "--init", "--recursive"], { ...options, cwd: roots.plugin, timeoutMs: 15 * 60_000 })
  }
  let changed = false
  let validation = await validateSubmodules(roots.plugin)
  if (!validation.ok && !await exists(path.join(roots.plugin, ".git"))) {
    for (const [name, url] of Object.entries(SUBMODULE_SOURCES)) {
      const target = path.join(roots.plugin, name)
      const markerMissing = validation.missing.some(item => item.startsWith(`${name} `))
      if (!markerMissing) continue
      const stat = await fs.stat(target).catch(() => null)
      if (stat && !stat.isDirectory()) throw new Error(`${target} 已存在但不是目录`)
      if (stat && (await fs.readdir(target)).length) continue
      if (stat) await fs.rm(target, { recursive: true, force: true })
      const temporary = `${target}.lotus-init-${process.pid}-${Date.now()}`
      try {
        await run("git", ["clone", "--depth", "1", url, temporary], { ...options, timeoutMs: 15 * 60_000 })
        const component = await validateSubmoduleComponent(temporary, name)
        if (!component.ok) throw new Error(`${name} 下载后校验失败：缺少 ${component.missing.join(", ")}`)
        await fs.rename(temporary, target)
        changed = true
      } finally {
        await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
      }
    }
    validation = await validateSubmodules(roots.plugin)
  }
  return validation.ok
    ? { ok: true, changed, value: Object.keys(validation.markers).join(" / ") }
    : { ok: false, value: `子模块文件不完整：${validation.missing.join("；")}` }
}

export async function validateSubmodules(targetRoot = pluginRoot) {
  const markers = submoduleMarkers()
  const missing = []
  for (const name of Object.keys(markers)) {
    const result = await validateSubmoduleComponent(path.join(targetRoot, name), name)
    if (!result.ok) missing.push(`${name} 缺少 ${result.missing.join(", ")}`)
  }
  return { ok: missing.length === 0, markers, missing }
}

function submoduleMarkers() {
  return {
    MihoyoBBSTools: ["requirements.txt", "main.py"],
    test_nine: ["requirements_without_train.txt", "main.py", "predict.py"],
    "nanoka-atlas-backend": ["package.json", "src/scrape.mjs"],
  }
}

async function validateSubmoduleComponent(target, name) {
  const files = submoduleMarkers()[name] || []
  const missing = []
  for (const file of files) if (!await exists(path.join(target, file))) missing.push(file)
  return { ok: missing.length === 0, missing }
}

async function ensureWorkspacePolicy(roots) {
  const file = path.join(roots.yunzai, "pnpm-workspace.yaml")
  const original = await fs.readFile(file, "utf8")
  const next = mergeWorkspacePolicy(original)
  if (next !== original) await atomicWrite(file, next)
  return { ok: true, changed: next !== original, value: "skia-canvas=true / protobufjs=false" }
}

export async function applyWorkspacePolicy(options = {}) {
  return ensureWorkspacePolicy({ yunzai: path.resolve(options.yunzaiRoot || yunzaiRoot) })
}

async function ensureUpdatePersistence(roots, options = {}) {
  const git = await resolveGitLayout(roots, options)
  if (!git) {
    return { ok: true, changed: false, value: "Yunzai 非标准 Git 工作树；保留 Lotus 启动时自动修复" }
  }
  const hooksRoot = git.hooksRoot
  await fs.mkdir(hooksRoot, { recursive: true })
  const pluginRelative = relativeInside(roots.yunzai, roots.plugin).replace(/\\/g, "/")
  let changed = false
  for (const name of ["post-checkout", "post-merge"]) {
    const file = path.join(hooksRoot, name)
    const original = await fs.readFile(file, "utf8").catch(() => "")
    const next = mergeManagedGitHook(original, { pluginRelative })
    if (next !== original) {
      await atomicWrite(file, next)
      await fs.chmod(file, 0o755).catch(() => {})
      changed = true
    }
  }
  return {
    ok: true,
    changed,
    value: changed ? "已安装 post-checkout/post-merge 无损保护" : "Git Hook 保护已存在",
  }
}

export async function applyUpdatePersistence(options = {}) {
  return ensureUpdatePersistence({
    yunzai: path.resolve(options.yunzaiRoot || yunzaiRoot),
    plugin: path.resolve(options.pluginRoot || pluginRoot),
  }, options)
}

export function mergeManagedGitHook(source = "", options = {}) {
  const begin = "# >>> Lotus workspace policy >>>"
  const end = "# <<< Lotus workspace policy <<<"
  const pluginRelative = String(options.pluginRelative || "plugins/Lotus-Plugin").replace(/\\/g, "/")
  const block = [
    begin,
    'LOTUS_YUNZAI_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
    `LOTUS_PLUGIN_REL=${shellSingleQuote(pluginRelative)}`,
    'LOTUS_PLUGIN_SCRIPT="$LOTUS_YUNZAI_ROOT/$LOTUS_PLUGIN_REL/scripts/initialize-lotus.mjs"',
    'LOTUS_GIT_DIR="$(git rev-parse --absolute-git-dir 2>/dev/null || printf \'%s/.git\' "$LOTUS_YUNZAI_ROOT")"',
    'if command -v node >/dev/null 2>&1 && [ -f "$LOTUS_PLUGIN_SCRIPT" ]; then',
    '  LOTUS_POLICY_LOG="$LOTUS_GIT_DIR/lotus-workspace-policy.log"',
    '  LOTUS_POLICY_STATUS="$LOTUS_GIT_DIR/lotus-workspace-policy.status.json"',
    '  LOTUS_POLICY_TMP="$LOTUS_POLICY_LOG.$$.tmp"',
    '  if node "$LOTUS_PLUGIN_SCRIPT" --workspace-policy-only >"$LOTUS_POLICY_TMP" 2>&1; then',
    '    mv -f "$LOTUS_POLICY_TMP" "$LOTUS_POLICY_LOG"',
    '    printf \'{"ok":true,"checkedAt":"%s"}\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$LOTUS_POLICY_STATUS"',
    '  else',
    '    LOTUS_POLICY_CODE=$?',
    '    mv -f "$LOTUS_POLICY_TMP" "$LOTUS_POLICY_LOG"',
    '    printf \'{"ok":false,"exitCode":%s,"checkedAt":"%s"}\\n\' "$LOTUS_POLICY_CODE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$LOTUS_POLICY_STATUS"',
    '    echo "[Lotus] workspace policy repair failed; see $LOTUS_POLICY_LOG" >&2',
    '  fi',
    "fi",
    end,
  ].join("\n")
  let text = String(source || "").replace(/\r\n/g, "\n")
  const managed = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g")
  text = text.replace(managed, "").trimEnd()
  if (!text) text = "#!/bin/sh"
  else if (!text.startsWith("#!")) text = `#!/bin/sh\n${text}`
  const newline = text.indexOf("\n")
  const shebang = newline < 0 ? text : text.slice(0, newline)
  const body = newline < 0 ? "" : text.slice(newline + 1).replace(/^\n+|\n+$/g, "")
  return `${shebang}\n\n${block}\n${body ? `\n${body}\n` : ""}`
}

async function ensureNodeDependencies(roots, options = {}) {
  const fingerprint = await nodeDependencyFingerprint(roots)
  const stateFile = path.join(roots.plugin, "data", "initialization", "node-dependencies.json")
  const state = await fs.readFile(stateFile, "utf8").then(JSON.parse, () => null)
  const existing = await checkNodeDependencies(roots, options)
  if (existing.ok && state?.fingerprint === fingerprint) {
    return { ok: true, changed: false, value: "依赖版本与构建策略未变化，跳过重复安装" }
  }
  const pnpm = await resolvePnpm(roots, options)
  await run(pnpm.command, [...pnpm.prefix, "install", "--ignore-scripts=false"], { ...options, cwd: roots.yunzai, timeoutMs: 20 * 60_000 })
  await run(pnpm.command, [...pnpm.prefix, "rebuild", "skia-canvas"], { ...options, cwd: roots.yunzai, timeoutMs: 20 * 60_000 })
  await fs.mkdir(path.dirname(stateFile), { recursive: true })
  const completedFingerprint = await nodeDependencyFingerprint(roots)
  await atomicWrite(stateFile, JSON.stringify({ fingerprint: completedFingerprint, completedAt: new Date().toISOString() }, null, 2) + "\n")
  return { ok: true, changed: true, value: "pnpm install + rebuild 完成" }
}

async function nodeDependencyFingerprint(roots) {
  const hash = createHash("sha256")
  for (const file of [
    path.join(roots.plugin, "package.json"),
    path.join(roots.yunzai, "pnpm-workspace.yaml"),
    path.join(roots.yunzai, "pnpm-lock.yaml"),
    path.join(roots.yunzai, "plugins", "Guoba-Plugin", "package.json"),
  ]) {
    hash.update(file)
    hash.update(await fs.readFile(file).catch(() => Buffer.from("<missing>")))
  }
  return hash.digest("hex")
}

async function ensureSkiaCanvas(roots, options = {}) {
  let checked = await checkNodeDependencies(roots, options)
  if (checked.ok) return checked
  const require = createRequire(path.join(roots.plugin, "package.json"))
  const entry = require.resolve("skia-canvas")
  const skiaRoot = path.dirname(path.dirname(entry))
  await run(process.execPath, ["lib/prebuild.mjs", "download", "--or-compile"], {
    ...options,
    cwd: skiaRoot,
    timeoutMs: 20 * 60_000,
  })
  checked = await checkNodeDependencies(roots, options)
  return checked.ok
    ? { ...checked, changed: true, value: "原生模块已下载或编译并通过 require 验证" }
    : checked
}

async function verifyBootstrap(roots, options = {}) {
  const dependency = await checkNodeDependencies(roots, options)
  if (!dependency.ok) return dependency
  const pnpm = await resolvePnpm(roots, options)
  const test = await run(pnpm.command, [...pnpm.prefix, "test"], {
    ...options,
    cwd: roots.plugin,
    timeoutMs: 10 * 60_000,
  })
  return { ok: true, value: `Node 依赖正常；测试退出码 ${test.code}` }
}

export async function resolvePnpm(roots = { plugin: pluginRoot, yunzai: yunzaiRoot }, options = {}) {
  const requested = await requestedPnpmVersion(roots)
  const direct = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
  if (await commandExists(direct, options)) {
    try {
      const version = await run(direct, ["--version"], { ...options, timeoutMs: 15_000 })
      if (!requested || version.stdout.trim() === requested) return { command: direct, prefix: [], version: version.stdout.trim() }
    } catch {}
  }
  const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack"
  if (requested && await commandExists(corepack, options)) return { command: corepack, prefix: [`pnpm@${requested}`], version: requested }
  if (await commandExists(direct, options)) return { command: direct, prefix: [] }
  throw new Error("未找到 pnpm 或 corepack；请先确认 Yunzai 的 Node/pnpm 环境完整")
}

async function requestedPnpmVersion(roots) {
  for (const root of [roots.yunzai, roots.plugin]) {
    const pkg = await fs.readFile(path.join(root, "package.json"), "utf8").then(JSON.parse, () => null)
    const declaration = pkg?.packageManager || pkg?.devEngines?.packageManager?.version || pkg?.engines?.pnpm
    const match = String(declaration || "").match(/(?:pnpm@)?(\d+\.\d+\.\d+)/)
    if (match) return match[1]
  }
  return ""
}

async function checkNodeDependencies(roots, options = {}) {
  if (typeof options.nodeDependencyCheck === "function") {
    return options.nodeDependencyCheck(roots, options)
  }
  const code = 'for (const n of ["cheerio","qrcode","skia-canvas","yaml"]) require(n)'
  try {
    await run(process.execPath, ["-e", code], { ...options, cwd: roots.plugin, timeoutMs: 60_000 })
    return { ok: true, value: "cheerio/qrcode/skia-canvas/yaml 可加载" }
  } catch (error) {
    return { ok: false, value: error.message }
  }
}

async function step(results, onEvent, name, task, metadata = {}) {
  await emit(onEvent, { type: "stage", state: "start", name })
  let result
  try {
    result = await task()
  } catch (error) {
    result = { ok: false, value: error.message }
  }
  const item = { name, critical: metadata.critical !== false, ...result }
  results.push(item)
  await emit(onEvent, { type: "stage", state: "end", ...item })
  return item
}

export function runProcess(command, args, options = {}) {
  if (typeof options.runner === "function") {
    return Promise.resolve()
      .then(() => options.runner(command, args, options))
      .then(result => {
        const code = result?.code ?? 0
        if (code === 0) return result
        const output = String(result?.stderr || result?.stdout || "").trim().slice(-1200)
        throw new Error(`${command} ${args.join(" ")} exited ${code}${output ? `: ${output}` : ""}`)
      })
  }
  return new Promise((resolve, reject) => {
    const baseEnv = options.env || process.env
    const launch = normalizeSpawnCommand(command, args, process.platform, process.env.ComSpec || "cmd.exe", baseEnv)
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: baseEnv,
      windowsHide: true,
      detached: process.platform !== "win32",
      ...(launch.spawnOptions || {}),
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    const limit = Number(options.outputLimit || 16_000)
    const append = (current, chunk) => (current + chunk.toString()).slice(-limit)
    child.stdout?.on("data", chunk => { stdout = append(stdout, chunk) })
    child.stderr?.on("data", chunk => { stderr = append(stderr, chunk) })
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(forceTimer)
      clearTimeout(rejectTimer)
      fn(value)
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminateChild(child, "SIGTERM")
      forceTimer = setTimeout(() => terminateChild(child, "SIGKILL"), Number(options.killGraceMs || 2_000))
      rejectTimer = setTimeout(() => {
        finish(reject, new Error(`${command} timed out after ${Number(options.timeoutMs || 5 * 60_000)}ms`))
      }, Number(options.killGraceMs || 2_000) + 2_000)
    }, Number(options.timeoutMs || 5 * 60_000))
    let forceTimer = null
    let rejectTimer = null
    child.on("error", error => finish(reject, error))
    child.on("close", code => {
      const result = { code, stdout, stderr }
      if (timedOut) {
        terminateChild(child, "SIGKILL")
        finish(reject, new Error(`${command} timed out after ${Number(options.timeoutMs || 5 * 60_000)}ms`))
      }
      else if (code === 0) finish(resolve, result)
      else finish(reject, new Error(`${command} ${args.join(" ")} exited ${code}: ${(stderr || stdout).trim().slice(-1200)}`))
    })
  })
}

export function normalizeSpawnCommand(command, args = [], platform = process.platform, comspec = process.env.ComSpec || "cmd.exe", baseEnv = process.env) {
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    const prefix = `LOTUS_RUN_${process.pid}_${randomUUID().replace(/-/g, "")}`
    const values = [command, ...args]
    const env = { ...baseEnv }
    const references = values.map((value, index) => {
      const key = `${prefix}_${index}`
      env[key] = String(value).replace(/"/g, '""')
      return `"%${key}%"`
    })
    return {
      command: comspec,
      args: ["/d", "/s", "/c", `"${references.join(" ")}"`],
      spawnOptions: { windowsVerbatimArguments: true, env },
    }
  }
  return { command, args }
}

const run = runProcess

function terminateChild(child, signal) {
  try {
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { windowsHide: true })
      killer.unref()
    } else if (child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try { child.kill(signal) } catch {}
  }
}

async function commandExists(command, options = {}) {
  try {
    await run(process.platform === "win32" ? "where.exe" : "sh", process.platform === "win32" ? [command] : ["-lc", `command -v ${command}`], {
      ...options,
      timeoutMs: 10_000,
    })
    return true
  } catch {
    return false
  }
}

async function atomicWrite(file, content) {
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, content)
  if (process.platform === "win32") await fs.rm(file, { force: true })
  await fs.rename(temp, file)
}

async function copyIfExists(source, target) {
  if (await exists(source)) await fs.copyFile(source, target)
}

async function copyWithParents(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(source, target)
}

async function readGitState(cwd) {
  if (!await exists(cwd)) return null
  try {
    const head = await runProcess("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 10_000 })
    const branch = await runProcess("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, timeoutMs: 10_000 }).then(result => result.stdout.trim(), () => "")
    const status = await runProcess("git", ["status", "--porcelain"], { cwd, timeoutMs: 10_000 })
    return { gitHead: head.stdout.trim() || null, gitBranch: branch || null, dirty: Boolean(status.stdout.trim()) }
  } catch {
    return null
  }
}

async function resolveGitLayout(roots, options = {}) {
  const standard = path.join(roots.yunzai, ".git")
  const stat = await fs.stat(standard).catch(() => null)
  try {
    const gitDirResult = await run("git", ["rev-parse", "--absolute-git-dir"], { ...options, cwd: roots.yunzai, timeoutMs: 10_000 })
    const hooksResult = await run("git", ["rev-parse", "--git-path", "hooks"], { ...options, cwd: roots.yunzai, timeoutMs: 10_000 })
    const gitDir = path.resolve(roots.yunzai, gitDirResult.stdout.trim())
    const hooksRoot = path.resolve(roots.yunzai, hooksResult.stdout.trim())
    return gitDirResult.stdout.trim() && hooksResult.stdout.trim() ? { gitDir, hooksRoot } : null
  } catch {
    return stat?.isDirectory() ? { gitDir: standard, hooksRoot: path.join(standard, "hooks") } : null
  }
}

function relativeInside(parent, child) {
  const relative = path.relative(parent, child)
  if (!relative || relative === "." || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`插件目录必须位于 Yunzai 根目录内：${child}`)
  }
  return relative
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}


function rollbackSource() {
  return `#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
const root = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await fs.readFile(path.join(root, "baseline.json"), "utf8"))
for (const item of manifest.files || []) {
  const target = item.target || path.join(manifest.yunzaiRoot, ...item.relative.split("/"))
  const backupKey = item.backupKey || item.relative
  if (item.existed) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(root, "files", ...backupKey.split("/")), target)
    if (item.mode != null) await fs.chmod(target, item.mode).catch(() => {})
  } else await fs.rm(target, { force: true })
}
for (const item of manifest.directories || []) {
  const target = path.join(manifest.yunzaiRoot, ...item.relative.split("/"))
  if (!item.existed) await fs.rm(target, { recursive: true, force: true })
  else if (item.restoreGit && item.gitHead && !item.dirty) {
    await command("git", ["checkout", item.gitBranch || "--detach", ...(item.gitBranch ? [] : [item.gitHead])], target)
    await command("git", ["reset", "--hard", item.gitHead], target)
  }
}
if (!process.argv.includes("--skip-dependencies")) {
  let declared = ""
  for (const packageRoot of [manifest.yunzaiRoot, manifest.pluginRoot]) {
    const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8").catch(() => "{}"))
    const value = pkg.packageManager || pkg.devEngines?.packageManager?.version || pkg.engines?.pnpm || ""
    declared = String(value).match(/(?:pnpm@)?(\\d+\\.\\d+\\.\\d+)/)?.[1] || ""
    if (declared) break
  }
  const direct = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
  const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack"
  const directVersion = await capture(direct, ["--version"], manifest.yunzaiRoot).then(value => value.trim(), () => "")
  let manager = { program: direct, prefix: [] }
  if (declared && directVersion !== declared) {
    const corepackAvailable = await capture(corepack, ["--version"], manifest.yunzaiRoot).then(() => true, () => false)
    if (corepackAvailable) manager = { program: corepack, prefix: ["pnpm@" + declared] }
    else if (!directVersion) throw new Error("Neither pnpm nor corepack is available for rollback")
  }
  await command(manager.program, [...manager.prefix, "install", "--ignore-scripts=false"], manifest.yunzaiRoot)
  await command(manager.program, [...manager.prefix, "rebuild", "skia-canvas"], manifest.yunzaiRoot)
}
console.log(process.argv.includes("--skip-dependencies")
  ? "Lotus initialization baseline restored; dependency reconciliation skipped."
  : "Lotus initialization baseline and node_modules restored.")
async function command(program, args, cwd) {
  await new Promise((resolve, reject) => {
    const launch = launchCommand(program, args)
    const child = spawn(launch.program, launch.args, { cwd, stdio: "inherit", windowsHide: true, ...(launch.options || {}) })
    child.on("error", reject)
    child.on("close", code => code === 0 ? resolve() : reject(new Error(program + " exited " + code)))
  })
}
async function capture(program, args, cwd) {
  return new Promise((resolve, reject) => {
    const launch = launchCommand(program, args)
    const child = spawn(launch.program, launch.args, { cwd, windowsHide: true, ...(launch.options || {}) })
    let stdout = ""
    child.stdout.on("data", chunk => { stdout += chunk })
    child.on("error", reject)
    child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(program + " exited " + code)))
  })
}
function launchCommand(program, args) {
  if (process.platform !== "win32" || !/\\.(?:cmd|bat)$/i.test(program)) return { program, args }
  const prefix = "LOTUS_ROLLBACK_" + process.pid + "_" + Date.now()
  const env = { ...process.env }
  const references = [program, ...args].map((value, index) => {
    const key = prefix + "_" + index
    env[key] = String(value).replace(/"/g, '""')
    return '"%' + key + '%"'
  })
  const line = '"' + references.join(" ") + '"'
  return { program: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", line], options: { windowsVerbatimArguments: true, env } }
}
`
}

async function exists(target) {
  return fs.access(target).then(() => true, () => false)
}

async function emit(handler, event) {
  try {
    await handler(event)
  } catch (error) {
    globalThis.logger?.warn?.(`[Lotus-Plugin] initializer progress notification failed (${event?.type || "unknown"}/${event?.name || event?.state || "-"}): ${error.message}`)
  }
}

function mergeMappingBlock(lines, key, entries) {
  lines = expandInlineBlock(lines, key, "mapping")
  let range = topLevelBlock(lines, key)
  if (!range) {
    if (lines.length && lines.at(-1) !== "") lines.push("")
    lines.push(`${key}:`)
    range = { start: lines.length - 1, end: lines.length }
  }
  for (const [name, value] of Object.entries(entries)) {
    const pattern = new RegExp(`^\\s{2,}["']?${escapeRegExp(name)}["']?\\s*:`)
    const index = lines.findIndex((line, offset) => offset > range.start && offset < range.end && pattern.test(line))
    if (index >= 0) {
      const indent = lines[index].match(/^\s*/)?.[0] || "  "
      lines[index] = `${indent}${name}: ${value}`
    } else {
      lines.splice(range.end, 0, `  ${name}: ${value}`)
      range.end += 1
    }
  }
  return lines
}

function mergeSequenceBlock(lines, key, required) {
  lines = expandInlineBlock(lines, key, "sequence")
  let range = topLevelBlock(lines, key)
  if (!range) {
    if (lines.length && lines.at(-1) !== "") lines.push("")
    lines.push(`${key}:`)
    range = { start: lines.length - 1, end: lines.length }
  }
  const values = lines.slice(range.start + 1, range.end)
    .map(line => line.match(/^\s*-\s*["']?([^"'#\s]+)["']?/)?.[1])
    .filter(Boolean)
  for (const value of required) {
    if (!values.includes(value)) {
      lines.splice(range.end, 0, `  - ${value}`)
      range.end += 1
    }
  }
  return lines
}

function topLevelBlock(lines, key) {
  const start = lines.findIndex(line => new RegExp(`^${escapeRegExp(key)}\\s*:`).test(line))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && (lines[end].trim() === "" || /^\s+/.test(lines[end]) || /^\s*#/.test(lines[end]))) end += 1
  return { start, end }
}

function expandInlineBlock(lines, key, type) {
  const index = lines.findIndex(line => new RegExp(`^${escapeRegExp(key)}\\s*:`).test(line))
  if (index < 0) return lines
  const match = lines[index].match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*?)\\s*$`))
  const value = match?.[1] || ""
  if (!value || value.startsWith("#")) return lines

  const open = type === "mapping" ? "{" : "["
  const close = type === "mapping" ? "}" : "]"
  const commentIndex = findCommentStart(value)
  const expression = (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trim()
  const comment = commentIndex >= 0 ? value.slice(commentIndex).trim() : ""
  if (!expression.startsWith(open) || !expression.endsWith(close)) {
    throw new Error(`${key} 必须使用 YAML 映射或列表，当前行内值无法安全合并`)
  }

  const body = expression.slice(1, -1).trim()
  const parts = body ? splitFlowValues(body) : []
  const expanded = type === "mapping"
    ? parts.map(part => {
        const separator = findUnquoted(part, ":")
        if (separator < 1) throw new Error(`${key} 的行内映射项无效：${part}`)
        const name = stripQuotes(part.slice(0, separator).trim())
        const itemValue = part.slice(separator + 1).trim()
        if (!name || !itemValue) throw new Error(`${key} 的行内映射项无效：${part}`)
        return `  ${name}: ${itemValue}`
      })
    : parts.map(part => `  - ${part.trim()}`)
  lines.splice(index, 1, `${key}:${comment ? ` ${comment}` : ""}`, ...expanded)
  return lines
}

function splitFlowValues(value) {
  const parts = []
  let start = 0
  let quote = ""
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\" && quote) {
      escaped = true
      continue
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? "" : char
      continue
    }
    if (char === "," && !quote) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  if (quote) throw new Error("YAML 行内值包含未闭合引号")
  parts.push(value.slice(start).trim())
  return parts.filter(Boolean)
}

function findUnquoted(value, target) {
  let quote = ""
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\" && quote) {
      escaped = true
      continue
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) quote = quote ? "" : char
    else if (char === target && !quote) return index
  }
  return -1
}

function findCommentStart(value) {
  let quote = ""
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if ((char === '"' || char === "'") && value[index - 1] !== "\\" && (!quote || quote === char)) quote = quote ? "" : char
    if (char === "#" && !quote && (index === 0 || /\s/.test(value[index - 1]))) return index
  }
  return -1
}

function stripQuotes(value) {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function localStamp() {
  const date = new Date()
  const part = value => String(value).padStart(2, "0")
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, "0")}-${process.pid}`
}

export async function withInitializationLock(task, options = {}) {
  const root = path.resolve(options.pluginRoot || pluginRoot)
  const lock = path.join(root, "data", "initialization", "initialize.lock")
  const guardFile = `${lock}.guard`
  await fs.mkdir(path.dirname(lock), { recursive: true })
  const guard = await acquireLockGuard(guardFile, options)
  let handle
  const token = randomUUID()
  try {
    try {
      handle = await fs.open(lock, "wx")
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      const state = await fs.stat(lock).catch(() => null)
      const owner = await readLockOwner(lock)
      const ownerAlive = owner?.pid && isProcessAlive(Number(owner.pid))
      const malformedFresh = !owner?.pid && state && Date.now() - state.mtimeMs <= Number(options.staleMs || 2 * 60 * 60_000)
      if (ownerAlive || malformedFresh) throw new Error(`已有初始化进程持有锁：${lock}`)
      await removeOwnedLock(lock, owner?.token, { allowLegacy: true })
      handle = await fs.open(lock, "wx")
    }
    await handle.writeFile(JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() }) + "\n")
  } catch (error) {
    await handle?.close().catch(() => {})
    await removeOwnedLock(lock, token)
    throw error
  } finally {
    await guard.handle.close().catch(() => {})
    await removeOwnedLock(guardFile, guard.token)
  }
  try {
    const heartbeat = setInterval(() => fs.utimes(lock, new Date(), new Date()).catch(() => {}), Number(options.heartbeatMs || 30_000))
    heartbeat.unref?.()
    try {
      return await task()
    } finally {
      clearInterval(heartbeat)
    }
  } finally {
    await handle.close().catch(() => {})
    await removeOwnedLock(lock, token)
  }
}

async function acquireLockGuard(file, options = {}) {
  const timeoutMs = Number(options.guardTimeoutMs || 30_000)
  const staleMs = Number(options.guardStaleMs || 30_000)
  const retryMs = Number(options.guardRetryMs || 25)
  const deadline = Date.now() + timeoutMs
  while (true) {
    const token = randomUUID()
    try {
      const handle = await fs.open(file, "wx")
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() }) + "\n")
        return { handle, token }
      } catch (error) {
        await handle.close().catch(() => {})
        await fs.rm(file, { force: true }).catch(() => {})
        throw error
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      const state = await fs.stat(file).catch(() => null)
      const owner = await readLockOwner(file)
      const stale = state && Date.now() - state.mtimeMs > staleMs
      if (stale && (!owner?.pid || !isProcessAlive(Number(owner.pid)))) {
        await removeOwnedLock(file, owner?.token, { allowLegacy: true })
        continue
      }
      if (Date.now() >= deadline) throw new Error(`初始化锁接管保护超时：${file}`)
      await new Promise(resolve => setTimeout(resolve, retryMs))
    }
  }
}

async function readLockOwner(file) {
  return fs.readFile(file, "utf8").then(JSON.parse, () => null)
}

async function removeOwnedLock(file, token, options = {}) {
  const current = await readLockOwner(file)
  if (token ? current?.token !== token : !options.allowLegacy || current?.token) return false
  await fs.rm(file, { force: true }).catch(() => {})
  return true
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--workspace-policy-only")) {
    const result = await applyWorkspacePolicy()
    process.stdout.write(`${JSON.stringify({ type: "workspace-policy", ...result })}\n`)
  } else if (process.argv.includes("--update-persistence-only")) {
    const result = await applyUpdatePersistence()
    process.stdout.write(`${JSON.stringify({ type: "update-persistence", ...result })}\n`)
  } else {
    const result = await withInitializationLock(() => runLotusBootstrap({
      onEvent: event => process.stdout.write(`${JSON.stringify(event)}\n`),
    }))
    process.stdout.write(`${JSON.stringify({ type: "complete", ...result })}\n`)
    process.exitCode = result.ok ? 0 : 1
  }
}
