import { createReadStream, createWriteStream } from "node:fs"
import fs from "node:fs/promises"
import crypto from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"
import YAML from "yaml"
import { isCookieRefreshableResponse } from "../../core/captcha/mysHandler.js"
import { loadGlobalConfig } from "../../core/config/global.js"

import {
  LOTUS_CAPTCHA_HANDLER_PRIORITY,
  LOTUS_CONFIG_DISABLED_PLUGIN_NAMES,
  LOTUS_CAPTCHA_HANDLER_NAMESPACE,
  LOTUS_INTERCEPT_PRIORITY,
} from "../../core/intercept/priority.js"

const IMAGE_SUMMARY_RELEASE_URL = "https://api.github.com/repos/palemoky/chinese-poetry-api/releases/latest"
const IMAGE_SUMMARY_FALLBACK_RELEASE_URL = "https://api.github.com/repos/palemoky/chinese-poetry-api/releases/tags/v0.5.0"
const IMAGE_SUMMARY_ASSET_NAME = "poetry.db.gz"
const IMAGE_SUMMARY_CACHE_DIR = path.join("temp", "Lotus-Plugin", "poetry")
const IMAGE_SUMMARY_LINE_LIMIT = 4096
const IMAGE_SUMMARY_RETRY_MS = 5 * 60 * 1000

let runtimeInstalled = false
let runtimeInstallPromise = null
let runtimeRetryScheduled = false
let imageSummaryLines = []
let imageSummaryPreparing = null
let imageSummaryNextPrepareAt = 0

export async function installLotusRuntimeInterception(options = {}) {
  if (runtimeInstalled) return { ok: true, already: true }
  if (runtimeInstallPromise) return runtimeInstallPromise

  runtimeInstallPromise = performRuntimeInterceptionInstall(options)
  try {
    return await runtimeInstallPromise
  } finally {
    runtimeInstallPromise = null
  }
}

async function performRuntimeInterceptionInstall(options = {}) {
  const config = options.config || await loadGlobalConfig()
  // conflict_takeover is retained only as a readable legacy configuration
  // field. Command ownership is no longer configurable: Lotus is always the
  // fallback for overlapping user-facing commands.
  const legacyConflictTakeoverIgnored = config.compatibility?.conflict_takeover === true
  const conflictTasks = [
    cleanupLegacyYunzaiConflictDisableConfig(),
    patchPluginsLoader(options.loader),
  ]

  const results = await Promise.allSettled([
    ...conflictTasks,
    patchGenshinMysInfoCookieRefresh(),
    installGlobalImageSummary(),
  ])

  const ok = results.every(item => item.status === "fulfilled" && item.value?.ok !== false)
  runtimeInstalled = ok
  if (!ok) scheduleRuntimeInterceptionRetry(options)

  return {
    ok,
    conflictTakeover: false,
    legacyConflictTakeoverIgnored,
    results,
  }
}

function scheduleRuntimeInterceptionRetry(options = {}) {
  if (runtimeRetryScheduled) return
  runtimeRetryScheduled = true
  const delays = [1000, 5000, 15000]

  delays.forEach((delay, index) => {
    setTimeout(async () => {
      await installLotusRuntimeInterception(options).catch(error => {
        logDebug(`runtime interception retry failed: ${error?.message || error}`)
      })
      if (index === delays.length - 1) runtimeRetryScheduled = false
    }, delay).unref?.()
  })

  globalThis.Bot?.once?.("online", () => {
    void installLotusRuntimeInterception(options).catch(error => {
      logDebug(`runtime interception online retry failed: ${error?.message || error}`)
    })
  })
}

export async function installLotusCaptchaHandlerOverride(handlerModule = null, options = {}) {
  const config = options.config || await loadGlobalConfig()
  const captchaPriorityTakeover = config.compatibility?.captcha_priority_takeover === true
  if (!captchaPriorityTakeover) {
    return { ok: true, skipped: true, reason: "captcha_priority_takeover_disabled" }
  }
  const Handler = handlerModule || await importYunzaiDefault("../../../../lib/plugins/handler.js")
  if (!Handler?.add || !Handler?.del) {
    return { ok: false, reason: "handler module unavailable" }
  }

  const registration = options.registration
  if (registration?.self && typeof registration.fn === "function") {
    Handler.add({
      ns: LOTUS_CAPTCHA_HANDLER_NAMESPACE,
      key: "mys.req.err",
      self: registration.self,
      fn: registration.fn,
      priority: LOTUS_CAPTCHA_HANDLER_PRIORITY,
    })
  }

  return {
    ok: true,
    conflictTakeover: false,
    captchaPriorityTakeover: true,
    fallbackHandlersPreserved: true,
  }
}

export async function cleanupLegacyYunzaiConflictDisableConfig(options = {}) {
  const file = options.file || path.join(process.cwd(), "config", "config", "group.yaml")
  const ownedNames = options.disabledNames || LOTUS_CONFIG_DISABLED_PLUGIN_NAMES

  try {
    let config
    try {
      config = YAML.parse(await fs.readFile(file, "utf8")) || {}
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { ok: true, skipped: true, file, reason: "config_missing" }
      }
      throw error
    }

    const currentDisable = Array.isArray(config?.default?.disable)
      ? config.default.disable.map(String)
      : []
    const hasLegacySignature = ownedNames.length > 0
      && ownedNames.every(name => currentDisable.includes(String(name)))
    if (!hasLegacySignature) {
      return { ok: true, skipped: true, file, reason: "legacy_signature_not_found" }
    }

    const owned = new Set(ownedNames.map(String))
    const nextDisable = currentDisable.filter(name => !owned.has(name))
    config.default.disable = nextDisable
    await fs.writeFile(file, YAML.stringify(config), "utf8")
    clearYunzaiCfgCache(options.cfg)
    logInfo(`已清理 Lotus 旧版自动写入的冲突禁用项：${currentDisable.length - nextDisable.length} 项`)
    return {
      ok: true,
      file,
      changed: true,
      removed: currentDisable.filter(name => owned.has(name)),
      disabled: nextDisable,
    }
  } catch (error) {
    logWarn(`清理 Lotus 旧版冲突禁用配置失败：${error?.message || error}`)
    return { ok: false, file, reason: error?.message || String(error) }
  }
}

export async function installGlobalImageSummary() {
  const patched = patchSegmentImageSummary()
  for (const delay of [0, 1000, 5000]) {
    setTimeout(() => patchSegmentImageSummary(), delay).unref?.()
  }
  void prepareImageSummaryCache()
  return patched
    ? { ok: true }
    : { ok: true, skipped: true, reason: "segment.image unavailable" }
}

export async function patchPluginsLoader(loaderOverride) {
  const loader = loaderOverride === undefined
    ? await importYunzaiDefault("../../../../lib/plugins/loader.js")
    : loaderOverride
  if (!Array.isArray(loader?.priority)) {
    return { ok: false, retryable: true, reason: "loader priority unavailable" }
  }

  if (!loader.__lotusInterceptPatch) {
    patchLoaderMethod(loader, "load")
    patchLoaderMethod(loader, "changePlugin")
    patchLoaderMethod(loader, "importPlugin")
    loader.__lotusInterceptPatch = true
  }

  scheduleEnforce(loader)
  enforceLotusInterception(loader)
  return { ok: true }
}

async function patchGenshinMysInfoCookieRefresh() {
  const MysInfo = await importRuntimeDefault("genshin", "model", "mys", "mysInfo.js")
  if (!MysInfo?.prototype?.checkCode || MysInfo.prototype.__lotusCookieRefreshPatch) {
    return { ok: true, skipped: true }
  }

  const originalCheckCode = MysInfo.prototype.checkCode
  MysInfo.prototype.checkCode = async function lotusCheckCode(res, type, mysApi = {}, data = {}, isTask = false) {
    if (isCookieRefreshableResponse(res)) {
      const handler = this.e?.runtime?.handler || {}
      if (handler.has?.("mys.req.err")) {
        const handled = await handler.call("mys.req.err", this.e, {
          mysApi,
          type,
          res,
          data,
          mysInfo: this,
        })
        if (handled) {
          res = handled
        }
      }
    }
    return originalCheckCode.call(this, res, type, mysApi, data, isTask)
  }
  MysInfo.prototype.__lotusCookieRefreshPatch = true
  logDebug("genshin MysInfo cookie refresh patch installed")
  return { ok: true }
}

function patchSegmentImageSummary() {
  const segment = globalThis.segment
  if (!segment || typeof segment.image !== "function") return false
  if (segment.__lotusImageSummaryPatch) {
    return true
  }

  const originalImage = segment.image.bind(segment)
  segment.image = (...args) => {
    const image = originalImage(...args)
    const summary = pickImageSummary()
    if (summary) attachImageSummary(image, summary)
    if (!summary && Date.now() >= imageSummaryNextPrepareAt) void prepareImageSummaryCache()
    return image
  }
  segment.__lotusImageSummaryPatch = true
  return true
}

function pickImageSummary() {
  if (!imageSummaryLines.length) return ""
  return imageSummaryLines[Math.floor(Math.random() * imageSummaryLines.length)] || ""
}

async function prepareImageSummaryCache() {
  if (imageSummaryPreparing) return imageSummaryPreparing

  imageSummaryPreparing = doPrepareImageSummaryCache()
    .catch(() => null)
    .finally(() => {
      imageSummaryPreparing = null
      imageSummaryNextPrepareAt = Date.now() + IMAGE_SUMMARY_RETRY_MS
    })

  return imageSummaryPreparing
}

async function doPrepareImageSummaryCache() {
  await loadCachedImageSummaryLines()

  const cacheDir = getImageSummaryCacheDir()
  const dbFile = path.join(cacheDir, "poetry.db")
  const release = await fetchPoetryRelease().catch(() => null)
  const manifest = await readJsonFile(path.join(cacheDir, "manifest.json")).catch(() => null)
  const hasDb = await fileExists(dbFile)
  const hasLines = imageSummaryLines.length > 0

  if (release && (!hasDb || !hasLines || manifest?.releaseKey !== release.releaseKey)) {
    const ok = await updatePoetryDbCache(cacheDir, release).catch(() => false)
    if (ok) await rebuildImageSummaryLines(dbFile, release.releaseKey)
    return
  }

  if (hasDb && !hasLines) await rebuildImageSummaryLines(dbFile, manifest?.releaseKey || "")
}

async function fetchPoetryRelease() {
  if (typeof fetch !== "function") return null
  const release = await fetchJson(IMAGE_SUMMARY_RELEASE_URL).catch(() => fetchJson(IMAGE_SUMMARY_FALLBACK_RELEASE_URL))
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const asset = assets.find(item => item?.name === IMAGE_SUMMARY_ASSET_NAME)
  if (!asset?.browser_download_url) return null

  const checksums = assets.find(item => /checksums\.txt$/i.test(item?.name || ""))
  const sha256 = checksums?.browser_download_url
    ? await fetchText(checksums.browser_download_url).then(text => parseChecksum(text, IMAGE_SUMMARY_ASSET_NAME)).catch(() => "")
    : ""
  const releaseKey = [
    release.tag_name || release.name || "",
    asset.name || "",
    asset.size || "",
    asset.updated_at || "",
    sha256 || "",
  ].join("|")

  return {
    releaseKey,
    tag: release.tag_name || "",
    assetUrl: asset.browser_download_url,
    assetName: asset.name,
    assetSize: Number(asset.size || 0),
    assetUpdatedAt: asset.updated_at || "",
    sha256,
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "Lotus-Plugin",
    },
  })
  if (!response.ok) throw new Error("release unavailable")
  return response.json()
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: "text/plain",
      "user-agent": "Lotus-Plugin",
    },
  })
  if (!response.ok) throw new Error("checksum unavailable")
  return response.text()
}

async function updatePoetryDbCache(cacheDir, release) {
  await fs.mkdir(cacheDir, { recursive: true })
  const gzFile = path.join(cacheDir, IMAGE_SUMMARY_ASSET_NAME)
  const dbFile = path.join(cacheDir, "poetry.db")
  const manifestFile = path.join(cacheDir, "manifest.json")
  const gzPart = `${gzFile}.part`
  const dbPart = `${dbFile}.part`

  await downloadFile(release.assetUrl, gzPart)
  if (release.sha256) {
    const actual = await hashFile(gzPart, "sha256")
    if (actual.toLowerCase() !== release.sha256.toLowerCase()) return false
  }
  await fs.rename(gzPart, gzFile)
  await pipeline(createReadStream(gzFile), createGunzip(), createWriteStream(dbPart))
  await fs.rename(dbPart, dbFile)
  await writeJsonFile(manifestFile, {
    releaseKey: release.releaseKey,
    tag: release.tag,
    assetName: release.assetName,
    assetSize: release.assetSize,
    assetUpdatedAt: release.assetUpdatedAt,
    sha256: release.sha256,
    updatedAt: new Date().toISOString(),
  })
  return true
}

async function downloadFile(url, target) {
  const response = await fetch(url, {
    headers: {
      accept: "application/octet-stream",
      "user-agent": "Lotus-Plugin",
    },
  })
  if (!response.ok) throw new Error("download unavailable")

  await fs.mkdir(path.dirname(target), { recursive: true })
  if (response.body) {
    const body = typeof Readable.fromWeb === "function"
      ? Readable.fromWeb(response.body)
      : response.body
    await pipeline(body, createWriteStream(target))
    return
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  await fs.writeFile(target, buffer)
}

async function rebuildImageSummaryLines(dbFile, releaseKey = "") {
  const lines = await generatePoetryLinesFromDb(dbFile).catch(() => [])
  if (!lines.length) return
  imageSummaryLines = lines
  await writeJsonFile(path.join(getImageSummaryCacheDir(), "lines.json"), {
    releaseKey,
    generatedAt: new Date().toISOString(),
    lines,
  }).catch(() => null)
}

async function loadCachedImageSummaryLines() {
  if (imageSummaryLines.length) return
  const cache = await readJsonFile(path.join(getImageSummaryCacheDir(), "lines.json")).catch(() => null)
  if (!Array.isArray(cache?.lines)) return
  imageSummaryLines = cache.lines
    .map(item => cleanSummaryPart(item))
    .filter(Boolean)
    .slice(0, IMAGE_SUMMARY_LINE_LIMIT)
}

async function generatePoetryLinesFromDb(dbFile) {
  const major = Number(String(process.versions.node || "").split(".")[0] || 0)
  if (major < 24) return generatePoetryLinesWithPython(dbFile)

  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import("node:sqlite"))
  } catch {
    return generatePoetryLinesWithPython(dbFile)
  }

  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const rows = db.prepare(`
      SELECT p.title AS title, p.content AS content, a.name AS author, d.name AS dynasty
      FROM poems_zh_hans p
      LEFT JOIN authors_zh_hans a ON a.id = p.author_id
      LEFT JOIN dynasties_zh_hans d ON d.id = p.dynasty_id
      WHERE p.content IS NOT NULL AND p.content != ''
      ORDER BY random()
      LIMIT 1200
    `).all()
    const lines = []
    for (const row of rows) {
      lines.push(...formatPoetryRowLines(row))
      if (lines.length >= IMAGE_SUMMARY_LINE_LIMIT) break
    }
    return shuffle(lines).slice(0, IMAGE_SUMMARY_LINE_LIMIT)
  } finally {
    db.close()
  }
}

async function generatePoetryLinesWithPython(dbFile) {
  const { spawn } = await import("node:child_process")
  const candidates = process.platform === "win32"
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]]
  const code = `
import json
import random
import re
import sqlite3
import sys

db_file = sys.argv[1]
limit = int(sys.argv[2])
con = sqlite3.connect(db_file)
rows = con.execute("""
  SELECT p.title AS title, p.content AS content, a.name AS author, d.name AS dynasty
  FROM poems_zh_hans p
  LEFT JOIN authors_zh_hans a ON a.id = p.author_id
  LEFT JOIN dynasties_zh_hans d ON d.id = p.dynasty_id
  WHERE p.content IS NOT NULL AND p.content != ''
  ORDER BY random()
  LIMIT 1200
""").fetchall()
lines = []
for title, content, author, dynasty in rows:
  try:
    parts = json.loads(content)
  except Exception:
    parts = [content]
  source = " ".join([part for part in [
    f"[{dynasty}]" if dynasty else "",
    author or "",
    f"《{title}》" if title else "",
  ] if part]).strip()
  for part in parts:
    for line in re.split(r"(?<=[。！？!?；;])\\s*|\\n+", str(part or "")):
      line = re.sub(r"<[^>]+>", "", line)
      line = re.sub(r"\\s+", " ", line).strip()
      if line:
        lines.append(f"{line} —— {source}" if source else line)
random.shuffle(lines)
sys.stdout.buffer.write(json.dumps(lines[:limit], ensure_ascii=False).encode("utf-8"))
`

  for (const [command, args] of candidates) {
    const lines = await runPythonLineExtractor(command, [...args, "-c", code, dbFile, String(IMAGE_SUMMARY_LINE_LIMIT)])
    if (lines.length) return lines
  }
  return []
}

function runPythonLineExtractor(command, args) {
  return new Promise(resolve => {
    let settled = false
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
    const chunks = []
    const done = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      done([])
    }, 30 * 1000)

    child.stdout.on("data", chunk => chunks.push(chunk))
    child.on("error", () => done([]))
    child.on("close", code => {
      if (code !== 0) return done([])
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        done(Array.isArray(parsed) ? parsed.map(item => cleanSummaryPart(item)).filter(Boolean) : [])
      } catch {
        done([])
      }
    })
  })
}

function formatPoetryRowLines(row) {
  const content = parsePoetryContent(row.content)
  const source = [
    row.dynasty ? `[${cleanSummaryPart(row.dynasty)}]` : "",
    cleanSummaryPart(row.author),
    row.title ? `《${cleanSummaryPart(row.title)}》` : "",
  ].filter(Boolean).join(" ")
  return content
    .flatMap(line => splitPoetrySentences(line))
    .map(line => cleanSummaryPart(line))
    .filter(Boolean)
    .map(line => source ? `${line} —— ${source}` : line)
}

function parsePoetryContent(content) {
  if (Array.isArray(content)) return content
  const text = String(content || "").trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed
  } catch {}
  return [text]
}

function parseChecksum(text = "", fileName = "") {
  for (const line of String(text || "").split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/, 2)
    if (name === fileName && /^[a-f0-9]{64}$/i.test(hash)) return hash
  }
  return ""
}

function getImageSummaryCacheDir() {
  return path.join(process.cwd(), IMAGE_SUMMARY_CACHE_DIR)
}

async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, "utf8"))
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value), "utf8")
}

async function fileExists(file) {
  return fs.access(file).then(() => true, () => false)
}

async function hashFile(file, algorithm) {
  const hash = crypto.createHash(algorithm)
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk)
  }
  return hash.digest("hex")
}

function shuffle(values) {
  const list = [...values]
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

function splitPoetrySentences(value = "") {
  return String(value || "")
    .replace(/\r/g, "\n")
    .split(/(?<=[。！？!?；;])\s*|\n+/u)
    .map(item => item.trim())
    .filter(Boolean)
}

function cleanSummaryPart(value = "") {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function attachImageSummary(payload, summary) {
  if (!payload) return
  if (Array.isArray(payload)) {
    for (const item of payload) attachImageSummary(item, summary)
    return
  }
  if (!isObjectPayload(payload)) return

  const type = String(payload.type || payload.data?.type || "").toLowerCase()
  const hasImageFile = Boolean(payload.file || payload.url || payload.data?.file || payload.data?.url)
  if (type === "image" || hasImageFile) {
    if (!payload.summary) payload.summary = summary
    if (isObjectPayload(payload.data) && !payload.data.summary) payload.data.summary = summary
  }
}

function isObjectPayload(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && !Buffer.isBuffer(value)
    && !(value instanceof ArrayBuffer)
    && !ArrayBuffer.isView(value)
}

function patchLoaderMethod(loader, name) {
  if (typeof loader[name] !== "function") return
  const original = loader[name].bind(loader)
  loader[name] = async (...args) => {
    const result = await original(...args)
    enforceLotusInterception(loader)
    return result
  }
}

function scheduleEnforce(loader) {
  for (const delay of [0, 1000, 5000]) {
    setTimeout(() => enforceLotusInterception(loader), delay).unref?.()
  }
  globalThis.Bot?.once?.("online", () => enforceLotusInterception(loader))
}

export function enforceLotusInterception(loader) {
  if (!Array.isArray(loader?.priority)) return { ok: false, reason: "loader priority unavailable" }

  loader.priority = loader.priority
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aPriority = isLotusEntry(a.entry)
        ? LOTUS_INTERCEPT_PRIORITY
        : numericPriority(a.entry.priority)
      const bPriority = isLotusEntry(b.entry)
        ? LOTUS_INTERCEPT_PRIORITY
        : numericPriority(b.entry.priority)
      if (aPriority < bPriority) return -1
      if (aPriority > bPriority) return 1
      if (isLotusEntry(a.entry) && !isLotusEntry(b.entry)) return 1
      if (!isLotusEntry(a.entry) && isLotusEntry(b.entry)) return -1
      return a.index - b.index
    })
    .map(item => item.entry)

  return { ok: true, pruned: 0 }
}

export function isLotusEntry(entry) {
  return String(entry?.key || "").startsWith("Lotus-Plugin")
    || String(entry?.name || "").startsWith("[Lotus-Plugin]")
}

async function importYunzaiDefault(relativePath) {
  try {
    const module = await import(new URL(relativePath, import.meta.url))
    return module.default || module
  } catch {
    return null
  }
}

async function importRuntimeDefault(...segments) {
  try {
    const modulePath = path.join(process.cwd(), "plugins", ...segments)
    const module = await import(pathToFileURL(modulePath).href)
    return module.default || module
  } catch {
    return null
  }
}

function numericPriority(value) {
  return Number.isFinite(value) || value === Number.NEGATIVE_INFINITY || value === Number.POSITIVE_INFINITY
    ? value
    : 5000
}

function unique(values) {
  return [...new Set(values.filter(value => value !== undefined && value !== null && value !== ""))]
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function clearYunzaiCfgCache(cfg) {
  if (cfg?.config && typeof cfg.config === "object") {
    delete cfg.config["config.group"]
  }
}

function logDebug(message) {
  globalThis.logger?.debug?.(`[Lotus-Plugin] ${message}`)
}

function logInfo(message) {
  globalThis.logger?.mark?.(`[Lotus-Plugin] ${message}`)
    || globalThis.logger?.info?.(`[Lotus-Plugin] ${message}`)
}

function logWarn(message) {
  globalThis.logger?.warn?.(`[Lotus-Plugin] ${message}`)
    || globalThis.logger?.error?.(`[Lotus-Plugin] ${message}`)
}
