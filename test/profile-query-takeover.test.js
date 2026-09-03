import test from "node:test"
import assert from "node:assert/strict"

globalThis.plugin = class {}
const { shouldTakeoverProfileQuery } = await import("../apps/profileQuery.js")

test("explicit profile suffix is always handled by Lotus", () => {
  assert.equal(shouldTakeoverProfileQuery({ hasProfileSuffix: true }, { compatibility: { conflict_takeover: false } }), true)
})

test("unsuffixed query follows conflict_takeover", () => {
  assert.equal(shouldTakeoverProfileQuery({ hasProfileSuffix: false }, { compatibility: { conflict_takeover: false } }), false)
  assert.equal(shouldTakeoverProfileQuery({ hasProfileSuffix: false }, { compatibility: { conflict_takeover: true } }), true)
})
