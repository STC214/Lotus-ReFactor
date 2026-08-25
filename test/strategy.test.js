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
  assert.equal(cached.authors[STRATEGY_AUTHORS[0].uid].posts[1].images[0], "https://img/2.jpg")
  await fs.rm(dir, { recursive: true, force: true })
})
