import test from "node:test"
import assert from "node:assert/strict"
import { inferServerFromUid } from "../core/mihoyo/regions.js"
import { resolveStarRailGachaRequest, StarRailGachaService } from "../services/starRailGacha/service.js"

const regions = [
  ["500000001", "prod_qd_cn", "hkrpg_cn", "api-takumi.mihoyo.com"],
  ["600000001", "prod_official_usa", "hkrpg_global", "sg-act-public-api.hoyolab.com"],
  ["700000001", "prod_official_euro", "hkrpg_global", "sg-act-public-api.hoyolab.com"],
  ["800000001", "prod_official_asia", "hkrpg_global", "sg-act-public-api.hoyolab.com"],
  ["900000001", "prod_official_cht", "hkrpg_global", "sg-act-public-api.hoyolab.com"],
  ["1800000001", "prod_official_asia", "hkrpg_global", "sg-act-public-api.hoyolab.com"],
]

test("Star Rail UID regions select the matching CN or global request family", () => {
  for (const [uid, expectedRegion, expectedBiz, expectedBadgeHost] of regions) {
    const region = inferServerFromUid(uid, "sr")
    const request = resolveStarRailGachaRequest(region)
    assert.equal(region, expectedRegion)
    assert.equal(request.gameBiz, expectedBiz)
    assert.equal(new URL(request.badgeLoginUrl).host, expectedBadgeHost)
    assert.equal(
      new URL(request.gachaApiRoot).host,
      expectedBiz === "hkrpg_cn" ? "act-api-takumi.mihoyo.com" : "sg-act-public-api.hoyolab.com",
    )
  }
  assert.throws(() => resolveStarRailGachaRequest("future_unknown_region"), /不支持的星铁区服/)
})

test("global badge and gacha requests carry matching region, game_biz and headers", async () => {
  const calls = []
  const service = new StarRailGachaService({
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options })
      return {
        ok: true,
        headers: { getSetCookie: () => [] },
        json: async () => ({ retcode: 0, data: {} }),
      }
    },
  })
  const region = "prod_official_euro"
  const request = resolveStarRailGachaRequest(region)
  const jar = { header: () => "ltoken_v2=test", update: () => {} }
  await service.badgeLogin({ uid: "700000001", region, jar, request })
  await service.requestGacha("brief", { uid: "700000001", region, jar, request, deviceId: "device" })

  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[0].url).host, "sg-act-public-api.hoyolab.com")
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    uid: "700000001",
    region,
    game_biz: "hkrpg_global",
    lang: "en-us",
  })
  const gachaUrl = new URL(calls[1].url)
  assert.equal(gachaUrl.host, "sg-act-public-api.hoyolab.com")
  assert.equal(gachaUrl.searchParams.get("region"), region)
  assert.equal(gachaUrl.searchParams.get("game_biz"), "hkrpg_global")
  assert.equal(calls[1].options.headers.Origin, "https://act.hoyolab.com")
})
