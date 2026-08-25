import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const STRATEGY_GAMES = Object.freeze({
  gs: { id: 2, label: "原神", slug: "ys" },
  sr: { id: 6, label: "星铁", slug: "sr" },
  zzz: { id: 8, label: "绝区零", slug: "zzz" },
})

export const STRATEGY_AUTHORS = Object.freeze([
  { uid: "387899471", nickname: "你的夏木繁", games: ["gs"] },
  { uid: "79695828", nickname: "Asgater", games: ["gs", "zzz"] },
  { uid: "74019947", nickname: "猫冬", games: ["gs"] },
  { uid: "352759746", nickname: "让我摸个鱼吧Moyu", aliases: ["让我莫格鱼吧Moyu"], games: ["sr"] },
  { uid: "137101761", nickname: "祈鸢ya", games: ["sr"] },
  { uid: "73603011", nickname: "小橙子阿", aliases: ["小橙子啊"], games: ["sr"] },
  { uid: "335322149", nickname: "丶ATRI丶", aliases: ["、ATRI、", "\\\\ATRI\\\\", "\\ATRI\\"], games: ["zzz"] },
  { uid: "4068738", nickname: "洗礼酱", games: ["zzz"] },
])

const DEFAULT_CACHE = fileURLToPath(new URL("../../data/strategy-authors/cache.json", import.meta.url))
const API = "https://bbs-api.mihoyo.com/post/wapi/userPost"
const DEFAULT_MAX_PAGES = 12
const DEFAULT_PAGE_SIZE = 50
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000

export class StrategySourceService {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.cacheFile = options.cacheFile || DEFAULT_CACHE
    this.maxPages = positiveInt(options.maxPages, DEFAULT_MAX_PAGES)
    this.pageSize = positiveInt(options.pageSize, DEFAULT_PAGE_SIZE)
    this.ttlMs = positiveInt(options.ttlMs, DEFAULT_TTL_MS)
    this.now = options.now || Date.now
  }

  async query(game, role, options = {}) {
    const gameInfo = STRATEGY_GAMES[game]
    const query = normalizeQuery(role)
    if (!gameInfo || !query) return { ok: false, reason: "invalid_query", game, role: query, items: [] }
    const sources = STRATEGY_AUTHORS.filter(source => source.games.includes(game))
    const cache = await this.readCache()
    const stale = sources.filter(source => options.forceRefresh === true || this.isStale(cache.authors[source.uid]))
    const failures = []
    for (const source of stale) {
      try {
        cache.authors[source.uid] = await this.fetchAuthor(source)
      } catch (error) {
        failures.push({ uid: source.uid, nickname: source.nickname, error: error.message })
      }
    }
    if (stale.length && stale.length !== failures.length) await this.writeCache(cache)
    const items = sources.flatMap(source => {
      const best = selectBestPost(cache.authors[source.uid]?.posts || [], gameInfo.id, query)
      return best ? [{ ...best, author: source.nickname, authorUid: source.uid, game, gameLabel: gameInfo.label, articleUrl: articleUrl(gameInfo.slug, best.postId) }] : []
    })
    return {
      ok: items.length > 0,
      reason: items.length ? "ok" : failures.length === sources.length ? "source_unavailable" : "not_found",
      game,
      gameLabel: gameInfo.label,
      role: query,
      items,
      failures,
      authors: sources.map(source => source.nickname),
    }
  }

  async refreshAll() {
    const previous = await this.readCache()
    const next = { version: 1, updatedAt: new Date(this.now()).toISOString(), authors: { ...previous.authors } }
    const results = []
    for (const source of STRATEGY_AUTHORS) {
      try {
        const entry = await this.fetchAuthor(source)
        next.authors[source.uid] = entry
        results.push({ uid: source.uid, nickname: source.nickname, ok: true, posts: entry.posts.length })
      } catch (error) {
        results.push({ uid: source.uid, nickname: source.nickname, ok: false, error: error.message, retained: Boolean(previous.authors[source.uid]) })
      }
    }
    await this.writeCache(next)
    return { ok: results.some(item => item.ok), results }
  }

  async fetchAuthor(source) {
    if (typeof this.fetchImpl !== "function") throw new Error("fetch is unavailable")
    const posts = []
    const seenPosts = new Set()
    const seenOffsets = new Set(["0"])
    let offset = "0"
    for (let page = 0; page < this.maxPages; page++) {
      const url = `${API}?uid=${encodeURIComponent(source.uid)}&size=${this.pageSize}&offset=${encodeURIComponent(offset)}`
      const response = await this.fetchImpl(url, { headers: { "user-agent": "Lotus-Plugin/strategy-source" } })
      if (!response?.ok) throw new Error(`HTTP ${response?.status || "unknown"}`)
      const payload = await response.json()
      if (Number(payload?.retcode || 0) !== 0) throw new Error(`API ${payload?.retcode}: ${payload?.message || "unknown"}`)
      const list = Array.isArray(payload?.data?.list) ? payload.data.list : []
      for (const row of list) {
        const post = normalizePost(row)
        if (!post?.postId || seenPosts.has(post.postId)) continue
        if (!authorMatches(row?.user?.nickname, source)) continue
        seenPosts.add(post.postId)
        posts.push(post)
      }
      if (payload?.data?.is_last === true || !payload?.data?.next_offset || list.length === 0) break
      const nextOffset = String(payload.data.next_offset)
      if (seenOffsets.has(nextOffset)) break
      seenOffsets.add(nextOffset)
      offset = nextOffset
    }
    return { nickname: source.nickname, updatedAt: new Date(this.now()).toISOString(), posts }
  }

  isStale(entry) {
    const updatedAt = Date.parse(entry?.updatedAt || "")
    return !Number.isFinite(updatedAt) || this.now() - updatedAt >= this.ttlMs
  }

  async readCache() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.cacheFile, "utf8"))
      return { version: 1, updatedAt: parsed.updatedAt || null, authors: parsed.authors && typeof parsed.authors === "object" ? parsed.authors : {} }
    } catch {
      return { version: 1, updatedAt: null, authors: {} }
    }
  }

  async writeCache(cache) {
    const target = path.resolve(this.cacheFile)
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`
    const data = `${JSON.stringify({ ...cache, version: 1, updatedAt: new Date(this.now()).toISOString() }, null, 2)}\n`
    await fs.writeFile(temp, data, "utf8")
    await fs.rename(temp, target)
  }
}

export function parseStrategyCommand(message = "") {
  const text = String(message).trim()
  const patterns = [
    { game: "sr", reg: /^\*(.+?)攻略$/i },
    { game: "zzz", reg: /^[%％](.+?)攻略$/i },
    { game: "sr", reg: /^#(?:星铁|星穹铁道|崩坏星穹铁道|崩铁)(.+?)攻略$/i },
    { game: "zzz", reg: /^#(?:绝区零|绝区)(.+?)攻略$/i },
    { game: "gs", reg: /^#(?:原神)?(.+?)攻略$/i },
  ]
  for (const item of patterns) {
    const match = item.reg.exec(text)
    const role = normalizeQuery(match?.[1])
    if (role && !/^(?:更新|刷新|全部|全量|帮助)/.test(role)) return { game: item.game, role }
  }
  return null
}

export function normalizeAuthorName(value = "") {
  return String(value).normalize("NFKC").toLowerCase().replace(/[\s丶、。·•・\\/|_—-]+/g, "")
}

export function selectBestPost(posts, gameId, role) {
  const needle = normalizeMatchText(role)
  const matched = posts.filter(post => Number(post.gameId) === Number(gameId) && normalizeMatchText(`${post.subject} ${post.content} ${(post.topics || []).join(" ")}`).includes(needle))
  return matched.sort((a, b) => scorePost(b, needle) - scorePost(a, needle) || Number(b.createdAt || 0) - Number(a.createdAt || 0))[0] || null
}

function scorePost(post, needle) {
  const subject = normalizeMatchText(post.subject)
  let score = Number(post.createdAt || 0) / 1e10
  if (subject.includes(needle)) score += 100
  if (/[一丨]图流|攻略图鉴/.test(post.subject)) score += 80
  if (/角色攻略|养成|培养|配装|配队/.test(post.subject)) score += 40
  if (/抽取建议|材料|任务|收集/.test(post.subject)) score -= 30
  score += Math.min(post.images?.length || 0, 12)
  return score
}

function normalizePost(row) {
  const raw = row?.post || {}
  const images = [...(Array.isArray(row?.image_list) ? row.image_list.map(item => item?.url) : []), ...(Array.isArray(raw.images) ? raw.images : [])].map(String).filter(Boolean)
  return {
    postId: String(raw.post_id || ""), gameId: Number(raw.game_id || 0), subject: String(raw.subject || "").trim(),
    content: String(raw.content || "").replace(/\[[^\]]+\]/g, " ").trim(),
    topics: Array.isArray(row?.topics) ? row.topics.map(item => String(item?.name || "")).filter(Boolean) : [],
    images: [...new Set(images)], createdAt: Number(raw.created_at || 0),
  }
}

function authorMatches(nickname, source) {
  const actual = normalizeAuthorName(nickname)
  return [source.nickname, ...(source.aliases || [])].some(name => normalizeAuthorName(name) === actual)
}

function articleUrl(slug, postId) { return `https://www.miyoushe.com/${slug}/article/${postId}` }
function normalizeQuery(value = "") { return String(value || "").normalize("NFKC").trim().replace(/^[\s#*%％]+|[\s#*%％]+$/g, "") }
function normalizeMatchText(value = "") { return String(value).normalize("NFKC").toLowerCase().replace(/[\s「」『』【】()（）·•・丶、。,，:：/\\|_—-]+/g, "") }
function positiveInt(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback }
