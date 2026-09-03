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
  assert.equal(calls[0].options.headers["x-rpc-lang"], "en-us")
  const gachaUrl = new URL(calls[1].url)
  assert.equal(gachaUrl.host, "sg-act-public-api.hoyolab.com")
  assert.equal(gachaUrl.searchParams.get("region"), region)
  assert.equal(gachaUrl.searchParams.get("game_biz"), "hkrpg_global")
  assert.equal(calls[1].options.headers.Origin, "https://act.hoyolab.com")
  assert.equal(calls[1].options.headers["x-rpc-lang"], "en-us")
})

test("profile update selects overseas cookie and language without CN refresh", async () => {
  let refreshCalls = 0
  const service = new StarRailGachaService({
    accountService: { refresh: async () => { refreshCalls += 1 } },
  })
  let received
  service.updateByCookie = async options => {
    received = options
    return { ok: true }
  }
  await service.updateByProfile({
    qq: "100",
    profileId: 6,
    profile: {
      account: {
        cookie: "cn-cookie",
        stoken: "cn-stoken",
        game_roles: { sr: [{ uid: "700000001", region: "prod_official_euro" }] },
        current_uid: { sr: "700000001" },
      },
      games: { os: { cookie: "global-cookie", lang: "zh_TW" } },
      device: { id: "device" },
    },
  })
  assert.equal(received.cookie, "global-cookie")
  assert.equal(received.lang, "zh-tw")
  assert.equal(received.region, "prod_official_euro")
  assert.equal(refreshCalls, 0)
})

test("expired overseas cookie reports rebind and never invokes CN refresh", async () => {
  let refreshCalls = 0
  const service = new StarRailGachaService({
    accountService: { refresh: async () => { refreshCalls += 1 } },
  })
  service.updateByCookie = async () => {
    const error = new Error("login expired")
    error.retcode = -100
    throw error
  }
  await assert.rejects(() => service.updateByProfile({
    qq: "100",
    profileId: 255,
    profile: {
      account: {
        cookie: "cn-cookie",
        stoken: "cn-stoken",
        game_roles: { sr: [{ uid: "900000001", region: "prod_official_cht" }] },
        current_uid: { sr: "900000001" },
      },
      games: { os: { cookie: "expired-global-cookie", lang: "zh-cn" } },
    },
  }), /重新绑定国际服 cookie/)
  assert.equal(refreshCalls, 0)
})

test("overseas profile never falls back to an available CN cookie", async () => {
  const service = new StarRailGachaService()
  await assert.rejects(() => service.updateByProfile({
    qq: "100",
    profileId: 1,
    profile: {
      account: {
        cookie: "cn-cookie-must-not-be-used",
        game_roles: { sr: [{ uid: "600000001", region: "prod_official_usa" }] },
        current_uid: { sr: "600000001" },
      },
      games: { os: { cookie: "", lang: "en-us" } },
    },
  }), /缺少国际服 cookie/)
})

test("CN profile keeps account cookie and refreshes it through AccountService", async () => {
  let refreshCalls = 0
  const service = new StarRailGachaService({
    accountService: {
      refresh: async () => {
        refreshCalls += 1
        return { account: { cookie: "refreshed-cn-cookie" }, device: { id: "refreshed-device" } }
      },
    },
  })
  const calls = []
  service.updateByCookie = async options => {
    calls.push(options)
    if (calls.length === 1) {
      const error = new Error("cookie expired")
      error.retcode = -100
      throw error
    }
    return { ok: true }
  }
  const result = await service.updateByProfile({
    qq: "100",
    profileId: 2,
    profile: {
      account: {
        cookie: "old-cn-cookie",
        stoken: "cn-stoken",
        game_roles: { sr: [{ uid: "100000001", region: "prod_gf_cn" }] },
        current_uid: { sr: "100000001" },
      },
      games: { os: { cookie: "global-cookie", lang: "en-us" } },
      device: { id: "old-device" },
    },
  })
  assert.equal(calls[0].cookie, "old-cn-cookie")
  assert.equal(calls[1].cookie, "refreshed-cn-cookie")
  assert.equal(calls[1].lang, "zh-cn")
  assert.equal(refreshCalls, 1)
  assert.equal(result.refreshedCookie, true)
})
