import assert from "node:assert/strict"
import test from "node:test"

import { createMiaoUidEvent } from "../services/pluginBridge/miaoPanel.js"
import { parsePanelUidIndex, resolveUidEntryByIndex } from "../services/pluginBridge/uidIndex.js"

test("panel UID index parser accepts the compact command suffix", () => {
  assert.equal(parsePanelUidIndex("#更新面板uid6"), 6)
  assert.equal(parsePanelUidIndex("#原神面板更新UID12"), 12)
  assert.equal(parsePanelUidIndex("#更新面板6"), 0)
})

test("panel UID index resolves the same one-based order shown by #uid", () => {
  const user = {
    getUidList(game) {
      assert.equal(game, "gs")
      return [
        { uid: "249186673", type: "ck" },
        { uid: "193431981", type: "reg" },
      ]
    },
  }
  const selected = resolveUidEntryByIndex(user, 2, "gs")
  assert.equal(selected.uid, "193431981")
  assert.equal(selected.entry.type, "reg")
  assert.throws(() => resolveUidEntryByIndex(user, 3, "gs"), /当前共有 2 个/)
})

test("miao UID event pins the explicit UID and drops stale profile Mys state", () => {
  const runtime = { e: { uid: "249186673" }, _mysInfo: { cookie: true } }
  const base = {
    user_id: "2301585812",
    _mys: { uid: "249186673" },
    runtime,
    reply: async () => true,
  }
  const { event } = createMiaoUidEvent({ e: base, uid: "193431981", game: "gs" })
  assert.equal(event.uid, "193431981")
  assert.equal(event.msg, "#原神更新面板193431981")
  assert.equal(event._mys, undefined)
  assert.notEqual(event.runtime, runtime)
  assert.equal(event.runtime.e, event)
  assert.deepEqual(event.runtime._mysInfo, {})
})
