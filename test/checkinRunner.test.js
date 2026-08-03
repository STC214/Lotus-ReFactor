import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"

import { ProfileSigninService } from "../services/checkin/profileSignin.js"
import { MihoyoBbsToolsRunner } from "../services/mihoyoBbsTools/runner.js"

const profile = {
  enabled: true,
  user: { qq: "10001" },
  profile: { id: 1 },
  account: { cookie: "cookie" },
  device: { bound: true },
  games: { cn: { enable: true } },
  mihoyobbs: { enable: false },
}

test("render failure does not overwrite a successful check-in outcome", async () => {
  const audits = []
  const service = new ProfileSigninService({
    runner: { runProfile: async () => ({ ok: true, message: "signed" }) },
    renderSigninResult: async () => { throw new Error("renderer down") },
    appendAudit: async outcome => audits.push(outcome),
  })
  const outcome = await service.run({ profile, refresh: false, source: "scheduled" })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.image, null)
  assert.equal(outcome.source, "scheduled")
  assert.equal(audits[0].source, "scheduled")
})

test("audit storage failure does not overwrite a successful check-in outcome", async () => {
  const service = new ProfileSigninService({
    runner: { runProfile: async () => ({ ok: true, message: "signed" }) },
    render: false,
    appendAudit: async () => { throw new Error("disk full") },
  })
  const outcome = await service.run({ profile, refresh: false, source: "scheduled" })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.message, "signed")
})

test("runner timeout terminates the child and returns a typed error", async () => {
  const signals = []
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = signal => {
    signals.push(signal)
    if (signal === "SIGTERM") setTimeout(() => child.emit("close", null), 0)
    return true
  }
  const runner = new MihoyoBbsToolsRunner({ spawn: () => child })
  await assert.rejects(
    runner.spawnRunner("python", [], { timeoutMs: 10 }),
    error => error.code === "LOTUS_RUNNER_TIMEOUT" && error.timeoutMs === 10,
  )
  assert.deepEqual(signals, ["SIGTERM"])
})

test("runner timeout rejects after grace period even when the child never closes", async () => {
  const signals = []
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = signal => {
    signals.push(signal)
    return true
  }
  const runner = new MihoyoBbsToolsRunner({ spawn: () => child })
  await assert.rejects(
    runner.spawnRunner("python", [], { timeoutMs: 5, killGraceMs: 5 }),
    error => error.code === "LOTUS_RUNNER_TIMEOUT",
  )
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
})
