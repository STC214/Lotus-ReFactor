import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import test from "node:test"

import { normalizeAuthorName, parseStrategyCommand, selectBestPost, StrategySourceService, STRATEGY_AUTHORS } from "../services/strategy/service.js"

test("strategy commands distinguish three games", () => {
  assert.deepEqual(parseStrategyCommand("#奥黛塔攻略"), { game: "gs", role: "奥黛塔" })
  assert.deepEqual(parseStrategyCommand("*长夜月攻略"), { game: "sr", role: "长夜月" })
  assert.deepEqual(parseStrategyCommand("#星铁长夜月攻略"), { game: "sr", role: "长夜月" })
  assert.deepEqual(parseStrategyCommand("％爱芮攻略"), { game: "zzz", role: "爱芮" })
  assert.deepEqual(parseStrategyCommand("#绝区零爱芮攻略"), { game: "zzz", role: "爱芮" })
  assert.equal(parseStrategyCommand("#更新全部攻略1"), null)
})

test("author aliases tolerate typo and decorative ATRI symbols", () => {
  assert.equal(normalizeAuthorName("丶ATRI丶"), normalizeAuthorName("、ATRI、"))
  assert.equal(normalizeAuthorName("\\\\ATRI\\\\"), "atri")
  assert.equal(STRATEGY_AUTHORS.some(item => item.aliases?.includes("让我莫格鱼吧Moyu")), true)
  assert.equal(STRATEGY_AUTHORS.some(item => item.aliases?.includes("小橙子啊")), true)
})

test("one-flow character guide outranks draw advice", () => {
  const best = selectBestPost([
    { postId: "1", gameId: 2, subject: "奥黛塔抽取建议", content: "", topics: [], images: ["a"], createdAt: 200 },
    { postId: "2", gameId: 2, subject: "「奥黛塔」一图流攻略｜培养养成", content: "", topics: [], images: ["a", "b"], createdAt: 100 },
  ], 2, "奥黛塔")
  assert.equal(best.postId, "2")
})

test("author pages are paginated, normalized and cached atomically", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-strategy-"))
  const cacheFile = path.join(dir, "cache.json")
  const calls = []
  const fetchImpl = async url => {
    calls.push(url)
    const second = url.includes("offset=next")
    return {
      ok: true, status: 200,
      async json() {
        return { retcode: 0, data: { list: [{ post: { post_id: second ? "2" : "1", game_id: 2, subject: second ? "奥黛塔一图流攻略" : "其他", content: "", images: second ? ["https://img/2.jpg"] : [], created_at: second ? 2 : 1 }, user: { nickname: "你的夏木繁" }, topics: [] }], is_last: second, next_offset: second ? "" : "next" } }
      },
    }
  }
  const service = new StrategySourceService({ fetchImpl, cacheFile, maxPages: 3, ttlMs: 60_000, now: () => 1_000 })
  const entry = await service.fetchAuthor(STRATEGY_AUTHORS[0])
  assert.equal(calls.length, 2)
  assert.equal(entry.posts.length, 2)
  await service.writeCache({ authors: { [STRATEGY_AUTHORS[0].uid]: entry } })
  const cached = await service.readCache()
  assert.equal(cached.authors[STRATEGY_AUTHORS[0].uid].posts[0].images[0], "https://img/2.jpg")
  await fs.rm(dir, { recursive: true, force: true })
})

test("incremental refresh stops at a known post and preserves older local posts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-strategy-incremental-"))
  const cacheFile = path.join(dir, "cache.json")
  const source = STRATEGY_AUTHORS[0]
  const calls = []
  const fetchImpl = async url => {
    calls.push(url)
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          retcode: 0,
          data: {
            list: [
              { post: { post_id: "new", game_id: 2, subject: "奥黛塔一图流攻略", content: "新增", images: ["https://img/new.jpg"], created_at: 300, updated_at: 300 }, user: { nickname: source.nickname }, topics: [] },
              { post: { post_id: "known", game_id: 2, subject: "旧攻略修订", content: "已更新", images: ["https://img/known-v2.jpg"], created_at: 200, updated_at: 250 }, user: { nickname: source.nickname }, topics: [] },
            ],
            is_last: false,
            next_offset: "must-not-be-requested",
          },
        }
      },
    }
  }
  const service = new StrategySourceService({ fetchImpl, cacheFile, now: () => 10_000 })
  await service.writeCache({ authors: { [source.uid]: {
    nickname: source.nickname,
    checkedAt: "1970-01-01T00:00:01.000Z",
    updatedAt: "1970-01-01T00:00:01.000Z",
    posts: [
      { postId: "known", gameId: 2, subject: "旧攻略", content: "旧", topics: [], images: ["https://img/known.jpg"], createdAt: 200, updatedAt: 200 },
      { postId: "older", gameId: 2, subject: "更早攻略", content: "保留", topics: [], images: [], createdAt: 100, updatedAt: 100 },
    ],
  } } })

  const result = await service.refreshSources([source])
  assert.equal(calls.length, 1)
  assert.equal(result.results[0].added, 1)
  assert.equal(result.results[0].updated, 1)
  assert.equal(result.results[0].posts, 3)
  const cached = await service.readCache()
  assert.deepEqual(cached.authors[source.uid].posts.map(item => item.postId), ["new", "known", "older"])
  assert.equal(cached.authors[source.uid].posts[1].content, "已更新")
  await fs.rm(dir, { recursive: true, force: true })
})

test("an old pinned post does not terminate incremental paging before newer posts", async () => {
  const source = STRATEGY_AUTHORS[0]
  const calls = []
  const row = (postId, createdAt) => ({ post: { post_id: postId, game_id: 2, subject: `${postId}攻略`, content: "", images: [], created_at: createdAt }, user: { nickname: source.nickname }, topics: [] })
  const service = new StrategySourceService({
    maxPages: 3,
    fetchImpl: async url => {
      calls.push(url)
      const second = url.includes("offset=next")
      return {
        ok: true,
        status: 200,
        async json() {
          return second
            ? { retcode: 0, data: { list: [row("new-page-2", 250), row("known", 100)], is_last: true, next_offset: "" } }
            : { retcode: 0, data: { list: [row("pinned", 50), row("new-page-1", 300)], is_last: false, next_offset: "next" } }
        },
      }
    },
  })
  const previous = {
    nickname: source.nickname,
    posts: [row("pinned", 50).post, row("known", 100).post].map(post => ({
      postId: post.post_id, gameId: post.game_id, subject: post.subject, content: post.content,
      topics: [], images: [], createdAt: post.created_at, updatedAt: post.created_at,
    })),
  }
  const result = await service.fetchAuthorIncremental(source, previous)
  assert.equal(calls.length, 2)
  assert.equal(result.added, 2)
  assert.equal(result.entry.posts.some(item => item.postId === "new-page-2"), true)
})

test("strategy query incrementally checks relevant authors and falls back to local cache", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-strategy-query-"))
  const cacheFile = path.join(dir, "cache.json")
  const source = STRATEGY_AUTHORS.find(item => item.games.includes("gs"))
  const localPost = { postId: "local", gameId: 2, subject: "奥黛塔一图流攻略", content: "本地缓存", topics: [], images: ["https://img/local.jpg"], createdAt: 100, updatedAt: 100 }
  const service = new StrategySourceService({
    cacheFile,
    fetchImpl: async () => { throw new Error("offline") },
  })
  await service.writeCache({ authors: { [source.uid]: { nickname: source.nickname, checkedAt: null, updatedAt: null, posts: [localPost] } } })

  const result = await service.query("gs", "奥黛塔")
  assert.equal(result.ok, true)
  assert.equal(result.items[0].postId, "local")
  assert.equal(result.failures.length > 0, true)
  const cached = await service.readCache()
  assert.equal(cached.authors[source.uid].posts[0].postId, "local")
  await fs.rm(dir, { recursive: true, force: true })
})
