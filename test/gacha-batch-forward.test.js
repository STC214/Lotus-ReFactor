import test from "node:test"
import assert from "node:assert/strict"

globalThis.plugin = class {}
const { buildBatchGachaForward } = await import("../apps/gachaLog.js")

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
