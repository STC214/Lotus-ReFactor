import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadGlobalConfig } from "../config/global.js"
import { resolveData } from "../path.js"

const IMAGE_URL_PATTERN = /^https?:\/\/[^\s"'<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>]*)?$/i
const IMAGE_URL_GLOBAL_PATTERN = /https?:\\?\/\\?\/[^\s"'<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>]*)?/gi
const MANIFEST_NAME = "manifest.json"
const GENERATIONS_DIR = "generations"
const DEFAULT_POOL_SIZE = 10
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_CLEANUP_DELAY_MS = 60 * 1000
const refreshPromises = new Map()

export async function getRenderBackground(configOverride = null, options = {}) {
  const backgrounds = await getRenderBackgrounds(1, configOverride, options)
  return backgrounds[0] || ""
}

export async function createRenderBackgroundProvider(configOverride = null, options = {}) {
  const config = configOverride || await loadGlobalConfig()
  let backgrounds = await ensureBackgroundPool(config, options)
  let cursor = 0
  backgrounds = shuffle(backgrounds, options.random)
  return async () => {
    if (!backgrounds.length) return ""
    let result = backgrounds[cursor % backgrounds.length]
    if (!await isBackgroundUrlUsable(result)) {
      backgrounds = shuffle((await readLocalBackgroundState(config, options)).files, options.random)
      cursor = 0
      result = backgrounds[0] || ""
    }
    if (!result) return ""
    cursor += 1
    if (cursor % backgrounds.length === 0) backgrounds = shuffle(backgrounds, options.random)
    return result
  }
}

export async function getRenderBackgrounds(count = 1, configOverride = null, options = {}) {
  const config = configOverride || await loadGlobalConfig()
  const backgrounds = shuffle(await ensureBackgroundPool(config, options), options.random)
  return backgrounds.slice(0, Math.max(1, Number(count) || 1))
}

// Compatibility export: this used to resolve and download a remote image for every render.
// It now resolves exclusively from the active local pool (or configured local files).
export async function resolveRenderBackgroundFromConfig(config, options = {}) {
  return getRenderBackground(config, options)
}

export async function ensureBackgroundPool(configOverride = null, options = {}) {
  const config = configOverride || await loadGlobalConfig()
  const state = await readLocalBackgroundState(config, options)
  if (state.complete || config.render?.background_pool_enable === false) {
    if (options.cleanupExisting && state.manifest?.generation) {
      await cleanupOldBackgrounds(resolvePoolRoot(options), state.manifest.generation)
    }
    return state.files
  }

  try {
    const result = await refreshBackgroundPool(config, options)
    return result.files || state.files
  } catch (error) {
    if (state.files.length) {
      globalThis.logger?.warn?.(`[Lotus-Plugin] 背景池修复失败，暂用 ${state.files.length} 张现存图片：${error.message}`)
      return state.files
    }
    throw error
  }
}

export async function refreshBackgroundPool(configOverride = null, options = {}) {
  const config = configOverride || await loadGlobalConfig()
  const poolRoot = resolvePoolRoot(options)
  const key = path.resolve(poolRoot)
  if (!refreshPromises.has(key)) {
    const promise = performBackgroundRefresh(config, { ...options, poolRoot })
      .finally(() => refreshPromises.delete(key))
    refreshPromises.set(key, promise)
  }
  return refreshPromises.get(key)
}

async function performBackgroundRefresh(config, options) {
  if (config.render?.background_pool_enable === false) {
    return { ok: true, skipped: true, reason: "disabled", files: (await readLocalBackgroundState(config, options)).files }
  }

  const sources = normalizeBackgroundSources(config.render?.background).filter(isHttpUrl)
  if (!sources.length) throw new Error("没有可测速的远程背景接口")

  const poolRoot = resolvePoolRoot(options)
  const generationsRoot = path.join(poolRoot, GENERATIONS_DIR)
  const poolSize = clampInteger(config.render?.background_pool_size, 1, 50, DEFAULT_POOL_SIZE)
  const retryFactor = clampInteger(config.render?.background_download_retries, 1, 10, 4)
  const generation = generationId(options.now || new Date())
  const staging = path.join(generationsRoot, `.staging-${generation}-${process.pid}`)
  const target = path.join(generationsRoot, generation)

  await fs.mkdir(staging, { recursive: true })
  try {
    const probes = await Promise.all(sources.map(source => probeBackgroundSource(source, config, options)))
    const ranked = probes.filter(item => item.ok).sort((a, b) => a.elapsedMs - b.elapsedMs)
    if (!ranked.length) {
      throw new Error(`背景接口测速全部失败：${probes.map(item => `${item.source}=${item.error}`).join("；")}`)
    }

    const downloaded = []
    const hashes = new Set()
    const winner = ranked[0]
    await saveCandidate(winner.image, staging, downloaded, hashes)
    for (const probe of ranked) delete probe.image

    for (const probe of ranked) {
      const maxAttempts = Math.max(poolSize, poolSize - downloaded.length + retryFactor)
      for (let attempt = 0; downloaded.length < poolSize && attempt < maxAttempts; attempt += 1) {
        try {
          const image = await fetchSourceImage(probe.source, config, options)
          await saveCandidate(image, staging, downloaded, hashes)
        } catch (error) {
          probe.downloadErrors ||= []
          probe.downloadErrors.push(error.message)
        }
      }
      if (downloaded.length >= poolSize) break
    }

    if (downloaded.length < poolSize) {
      throw new Error(`背景池仅获得 ${downloaded.length}/${poolSize} 张不重复图片，保留上一批图片`)
    }

    await fs.rm(target, { recursive: true, force: true })
    await fs.rename(staging, target)
    const files = downloaded.map(item => path.join(target, item.name))
    const manifest = {
      version: 1,
      generation,
      refreshedAt: (options.now || new Date()).toISOString(),
      selectedSource: winner.source,
      poolSize,
      probes: probes.map(({ source, ok, elapsedMs, error }) => ({ source, ok, elapsedMs, error })),
      files: downloaded,
    }
    await writeJsonAtomic(path.join(poolRoot, MANIFEST_NAME), manifest)
    await scheduleOldBackgroundCleanup(poolRoot, options.cleanupDelayMs)
    const urls = files.map(file => pathToFileURL(file).href)
    globalThis.logger?.mark?.(`[Lotus-Plugin] 背景池已更新：${urls.length} 张，最快接口 ${winner.source} (${winner.elapsedMs}ms)`)
    return { ok: true, files: urls, manifest, probes: manifest.probes }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export async function probeBackgroundSources(configOverride = null, options = {}) {
  const config = configOverride || await loadGlobalConfig()
  const sources = normalizeBackgroundSources(config.render?.background).filter(isHttpUrl)
  return Promise.all(sources.map(source => probeBackgroundSource(source, config, options)))
}

export function resolveSuperResolutionScale(preset = "off") {
  return ({ off: 1, low: 1.5, medium: 2, high: 3, ultra: 4 })[String(preset || "off").toLowerCase()] || 1
}

export function normalizeBackgroundSources(value) {
  if (Array.isArray(value)) return value.flatMap(item => normalizeBackgroundSources(item))
  const text = String(value || "").trim()
  if (!text) return []
  return text.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
}

async function readLocalBackgroundState(config, options) {
  const poolRoot = resolvePoolRoot(options)
  const manifest = await readJson(path.join(poolRoot, MANIFEST_NAME))
  const pooled = []
  const expectedPoolSize = clampInteger(config.render?.background_pool_size, 1, 50, DEFAULT_POOL_SIZE)
  if (manifest?.generation && Array.isArray(manifest.files)) {
    for (const item of manifest.files) {
      const file = path.join(poolRoot, GENERATIONS_DIR, manifest.generation, path.basename(item.name || ""))
      if (await isManifestFileUsable(file, item)) pooled.push(pathToFileURL(file).href)
    }
  }
  if (pooled.length >= expectedPoolSize && manifest.files.length >= expectedPoolSize) {
    return { files: pooled, complete: true, manifest }
  }

  const local = []
  for (const source of normalizeBackgroundSources(config.render?.background).filter(item => !isHttpUrl(item))) {
    local.push(...await expandLocalBackgroundSource(source))
  }
  const hasRemoteSources = normalizeBackgroundSources(config.render?.background).some(isHttpUrl)
  return {
    files: pooled.length ? pooled : local,
    complete: !hasRemoteSources && local.length > 0,
    manifest,
  }
}

async function probeBackgroundSource(source, config, options) {
  const started = performance.now()
  try {
    const image = await fetchSourceImage(source, config, options)
    return { source, ok: true, elapsedMs: Math.max(1, Math.round(performance.now() - started)), image }
  } catch (error) {
    return { source, ok: false, elapsedMs: Math.max(1, Math.round(performance.now() - started)), error: error.message }
  }
}

async function fetchSourceImage(source, config, options) {
  const timeoutMs = clampInteger(config.render?.background_timeout_ms, 500, 120000, 3000)
  const deadline = Date.now() + timeoutMs
  const remaining = () => {
    const value = deadline - Date.now()
    if (value <= 0) throw new Error(`接口总耗时超过 ${timeoutMs}ms`)
    return value
  }
  const first = await fetchWithTimeout(source, remaining(), options.fetch)
  if (!first.ok) throw new Error(`HTTP ${first.status}`)
  const firstType = first.headers.get("content-type") || ""
  if (/^image\//i.test(firstType)) return responseToImage(first, source, config)

  const firstBuffer = Buffer.from(await first.arrayBuffer())
  if (isImageBuffer(firstBuffer, firstType)) return bufferToImage(firstBuffer, firstType, first.url || source, config)
  const bodyText = firstBuffer.toString("utf8")
  const urls = extractImageUrls(parseMaybeJson(bodyText) || bodyText)
  if (!urls.length) throw new Error("接口没有返回图片地址")
  const errors = []
  for (const imageUrl of shuffle(urls, options.random).slice(0, 12)) {
    try {
      const response = await fetchWithTimeout(imageUrl, remaining(), options.fetch)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await responseToImage(response, imageUrl, config)
    } catch (error) {
      errors.push(error.message)
    }
  }
  throw new Error(`接口返回的图片地址均不可用：${errors.slice(0, 3).join(" / ")}`)
}

async function responseToImage(response, url, config) {
  const contentLength = Number(response.headers.get("content-length") || 0)
  const maxBytes = clampInteger(config.render?.background_max_bytes, 1024, 100 * 1024 * 1024, DEFAULT_MAX_IMAGE_BYTES)
  if (contentLength > maxBytes) throw new Error(`图片超过 ${maxBytes} 字节限制`)
  const buffer = Buffer.from(await response.arrayBuffer())
  return bufferToImage(buffer, response.headers.get("content-type") || "", response.url || url, config)
}

function bufferToImage(buffer, contentType, url, config) {
  const maxBytes = clampInteger(config.render?.background_max_bytes, 1024, 100 * 1024 * 1024, DEFAULT_MAX_IMAGE_BYTES)
  if (buffer.length > maxBytes) throw new Error(`图片超过 ${maxBytes} 字节限制`)
  if (!isImageBuffer(buffer, contentType)) throw new Error("响应内容不是图片")
  return { buffer, ext: detectImageExt(buffer, contentType, url), url }
}

async function saveCandidate(image, staging, downloaded, hashes) {
  if (!image?.buffer) return false
  const hash = crypto.createHash("sha256").update(image.buffer).digest("hex")
  if (hashes.has(hash)) return false
  hashes.add(hash)
  const name = `${String(downloaded.length + 1).padStart(2, "0")}-${hash.slice(0, 16)}.${image.ext}`
  await fs.writeFile(path.join(staging, name), image.buffer)
  downloaded.push({ name, sha256: hash, bytes: image.buffer.length, sourceUrl: image.url })
  return true
}

async function cleanupOldBackgrounds(poolRoot, activeGeneration) {
  const generationsRoot = path.join(poolRoot, GENERATIONS_DIR)
  for (const entry of await fs.readdir(generationsRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith(".staging-")) {
      const staging = path.join(generationsRoot, entry.name)
      const stat = await fs.stat(staging).catch(() => null)
      if (stat && Date.now() - stat.mtimeMs > 60 * 60 * 1000) {
        await fs.rm(staging, { recursive: true, force: true })
      }
      continue
    }
    if (entry.name !== activeGeneration) await fs.rm(path.join(generationsRoot, entry.name), { recursive: true, force: true })
  }
  for (const entry of await fs.readdir(poolRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name !== MANIFEST_NAME && /\.(?:png|jpe?g|webp|gif)$/i.test(entry.name)) {
      await fs.rm(path.join(poolRoot, entry.name), { force: true })
    }
  }
}

function scheduleOldBackgroundCleanup(poolRoot, delayOverride) {
  const delayMs = clampInteger(delayOverride, 0, 10 * 60 * 1000, DEFAULT_CLEANUP_DELAY_MS)
  const cleanup = async () => {
    const manifest = await readJson(path.join(poolRoot, MANIFEST_NAME))
    if (manifest?.generation) await cleanupOldBackgrounds(poolRoot, manifest.generation)
  }
  if (delayMs === 0) return cleanup()
  const timer = setTimeout(() => {
    cleanup().catch(error => globalThis.logger?.warn?.(`[Lotus-Plugin] 旧背景批次清理失败：${error.message}`))
  }, delayMs)
  timer.unref?.()
  return timer
}

async function fetchWithTimeout(url, timeoutMs, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("fetch 不可用")
  if (typeof AbortSignal.timeout === "function") {
    return fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "Lotus-Plugin/0.1 background-pool" },
    })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { signal: controller.signal, headers: { "user-agent": "Lotus-Plugin/0.1 background-pool" } })
  } finally {
    clearTimeout(timer)
  }
}

function extractImageUrls(value, results = []) {
  if (!value) return results
  if (typeof value === "string") {
    for (const match of value.match(IMAGE_URL_GLOBAL_PATTERN) || []) results.push(match.replaceAll("\\/", "/"))
    if (IMAGE_URL_PATTERN.test(value)) results.push(value)
    return unique(results)
  }
  if (Array.isArray(value)) {
    for (const item of value) extractImageUrls(item, results)
    return unique(results)
  }
  if (typeof value !== "object") return unique(results)
  for (const key of ["download_url", "data", "url", "imgurl", "img", "image", "pic", "acgurl", "link"]) extractImageUrls(value[key], results)
  for (const next of Object.values(value)) extractImageUrls(next, results)
  return unique(results)
}

function parseMaybeJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

function isImageBuffer(buffer, contentType = "") {
  if (!buffer || buffer.length < 16) return false
  return /^image\//i.test(contentType)
    || buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))
    || buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP")
    || buffer.subarray(0, 3).toString("ascii") === "GIF"
}

function detectImageExt(buffer, contentType = "", url = "") {
  if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) return "jpg"
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png"
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp"
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") return "gif"
  if (contentType.includes("png") || /\.png(?:\?|$)/i.test(url)) return "png"
  if (contentType.includes("webp") || /\.webp(?:\?|$)/i.test(url)) return "webp"
  if (contentType.includes("gif") || /\.gif(?:\?|$)/i.test(url)) return "gif"
  return "jpg"
}

function resolvePoolRoot(options) {
  return path.resolve(options.poolRoot || resolveData("render-backgrounds"))
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")) } catch { return null }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await fs.rm(file, { force: true })
  await fs.rename(temp, file)
}

async function isUsableFile(file) {
  try {
    const stat = await fs.stat(file)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

async function expandLocalBackgroundSource(source) {
  const value = String(source || "").trim()
  if (!value) return []
  if (/^data:/i.test(value)) return [value]
  let target
  try {
    target = /^file:/i.test(value) ? fileURLToPath(value) : path.isAbsolute(value) ? value : path.resolve(value)
  } catch {
    return []
  }
  try {
    const stat = await fs.stat(target)
    if (stat.isFile() && stat.size > 0) return [pathToFileURL(target).href]
    if (!stat.isDirectory()) return []
    const files = []
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:png|jpe?g|webp|gif)$/i.test(entry.name)) continue
      const file = path.join(target, entry.name)
      if (await isUsableFile(file)) files.push(pathToFileURL(file).href)
    }
    return files
  } catch {
    return []
  }
}

async function isManifestFileUsable(file, item = {}) {
  try {
    const stat = await fs.stat(file)
    return stat.isFile() && stat.size > 0 && (!Number(item.bytes) || stat.size === Number(item.bytes))
  } catch {
    return false
  }
}

async function isBackgroundUrlUsable(value) {
  if (!value || /^data:/i.test(value)) return Boolean(value)
  if (!/^file:/i.test(value)) return true
  try { return await isUsableFile(fileURLToPath(value)) } catch { return false }
}

function generationId(date) {
  return `${date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}-${crypto.randomBytes(3).toString("hex")}`
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value)
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback
}

function isHttpUrl(value) { return /^https?:\/\//i.test(String(value || "")) }

function shuffle(values = [], random = Math.random) {
  const next = [...values]
  for (let index = next.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[next[index], next[target]] = [next[target], next[index]]
  }
  return next
}

function pick(values = [], random = Math.random) {
  return values.length ? values[Math.floor(random() * values.length)] : ""
}

function unique(values = []) { return [...new Set(values.filter(Boolean))] }
