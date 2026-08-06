import { importRuntimeModule } from "./common.js"

const UID_PATTERN = /^[1-9]\d{7,9}$/

export function parsePanelUidIndex(message = "") {
  const match = String(message).trim().match(/uid([1-9]\d{0,2})$/i)
  return match ? Number(match[1]) : 0
}

export function resolveUidEntryByIndex(user, index, game = "gs") {
  const normalizedIndex = Number(index)
  if (!Number.isInteger(normalizedIndex) || normalizedIndex < 1) {
    throw new Error("UID 序号必须是大于 0 的整数")
  }

  const uidList = user?.getUidList?.(game)
  if (!Array.isArray(uidList) || uidList.length === 0) {
    throw new Error(`当前没有绑定${gameLabel(game)} UID，请先使用${game === "sr" ? "*uid" : "#uid"}查看或绑定`)
  }
  if (normalizedIndex > uidList.length) {
    throw new Error(`UID 序号 ${normalizedIndex} 不存在；当前共有 ${uidList.length} 个${gameLabel(game)} UID`)
  }

  const entry = uidList[normalizedIndex - 1]
  const uid = String(entry?.uid || entry || "")
  if (!UID_PATTERN.test(uid)) {
    throw new Error(`UID 序号 ${normalizedIndex} 对应的数据无效`)
  }

  return {
    index: normalizedIndex,
    uid,
    entry,
    game,
  }
}

export async function resolveEventUidByIndex(e, index, game = "gs") {
  let user = e?.runtime?.user || e?.user
  if (!user || typeof user.getUidList !== "function") {
    const mod = await importRuntimeModule("genshin", "model", "mys", "NoteUser.js")
    user = await mod.default.create(e)
  }
  return resolveUidEntryByIndex(user, index, game)
}

function gameLabel(game) {
  return game === "sr" ? "星铁" : "原神"
}
