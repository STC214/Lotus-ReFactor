import test from "node:test"
import assert from "node:assert/strict"

globalThis.plugin = class {}
const { buildBatchGachaForward, replyBatchGachaForward } = await import("../apps/gachaLog.js")

test("batch gacha forward keeps one complete node per profile without truncation", () => {
  const profileIds = [1, 2, 3, 4, 5, 6, 7, 255]
  const results = profileIds.flatMap(profileId => [
    { profileId, game: "gs", ok: true, uid: `gs-${profileId}` },
    { profileId, game: "sr", ok: false, error: `sr-error-${profileId}` },
    { profileId, game: "zzz", skipped: true },
  ])
  const nodes = buildBatchGachaForward({ userId: "100", profileIds, results, done: 8, skipped: 8, failed: 8 })
  assert.equal(nodes.length, profileIds.length + 1)
  for (const profileId of profileIds) {
    const node = nodes.find(item => item.startsWith(`Profile ${profileId}\n`))
    assert.match(node, new RegExp(`gs-${profileId}`))
    assert.match(node, new RegExp(`sr-error-${profileId}`))
    assert.match(node, /绝区零：未绑定 UID，跳过/)
  }
})

test("batch gacha reply builds and sends one QQ forward message", async () => {
  const sent = []
  let forwardedNodes = []
  const target = {
    e: {
      user_id: "100",
      friend: {
        makeForwardMsg: async nodes => {
          forwardedNodes = nodes
          return { type: "forward", data: { meta: { detail: {} } } }
        },
      },
    },
    reply: async payload => { sent.push(payload); return { message_id: "1" } },
  }
  const summary = {
    userId: "100",
    profileIds: [1, 2, 6, 255],
    results: [1, 2, 6, 255].flatMap(profileId => [
      { profileId, game: "gs", ok: true, uid: `gs-${profileId}` },
      { profileId, game: "sr", ok: true, uid: `sr-${profileId}` },
      { profileId, game: "zzz", ok: true, uid: `zzz-${profileId}` },
    ]),
    done: 12,
    skipped: 0,
    failed: 0,
  }
  const result = await replyBatchGachaForward(target, summary)
  assert.equal(result.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(forwardedNodes.length, summary.profileIds.length + 1)
  assert.match(forwardedNodes.at(-1).message, /Profile 255/)
  assert.match(forwardedNodes.at(-1).message, /绝区零：UID zzz-255 · 完成/)
})

test("batch gacha reply falls back to complete individual messages", async () => {
  const sent = []
  const target = {
    e: { user_id: "100" },
    reply: async payload => { sent.push(payload); return { message_id: String(sent.length) } },
  }
  const summary = {
    userId: "100",
    profileIds: [1, 2],
    results: [
      { profileId: 1, game: "gs", ok: true, uid: "gs-1" },
      { profileId: 2, game: "sr", ok: false, error: "profile-2-error" },
    ],
    done: 1,
    skipped: 0,
    failed: 1,
  }
  const result = await replyBatchGachaForward(target, summary)
  assert.equal(result.fallback, true)
  assert.equal(sent.length, summary.profileIds.length + 1)
  assert.match(sent.at(-1), /profile-2-error/)
})
