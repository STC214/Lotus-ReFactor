import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import YAML from "yaml"
import { SchedulerService } from "../core/scheduler/service.js"
import { ScheduledSigninService } from "../services/checkin/scheduled.js"
import { ProfileSigninService } from "../services/checkin/profileSignin.js"
import { createDefaultGlobalConfig } from "../core/config/defaults.js"
import { migrateGlobalConfig } from "../core/config/global.js"
import { validateGlobalConfig } from "../core/config/schema.js"
import { AutoPreviewRedeem } from "../services/redeemCodes/auto.js"
import { StarRailGachaService } from "../services/starRailGacha/service.js"

const profile = { enabled: true, user: { qq: "10001" }, profile: { id: 1 }, account: { cookie: "fixture" }, schedule: { mode: "inherit" } }
const config = createDefaultGlobalConfig()
const failedCommunity = { ok: false, stage: "checkin", profile, message: "retry",
  result: { retryCommunityForums: [2], tasks: [{ kind: "community", key: 2, status: "failed", retryable: true }] } }
const successCommunity = { ok: true, stage: "checkin", profile, message: "ok",
  result: { tasks: [{ kind: "community", key: 2, status: "success" }] } }

async function fixture(t, initial = new Date(2026, 10, 18, 4, 30)) {
  const planDir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-1118-"))
  t.after(() => fs.rm(planDir, { recursive: true, force: true }))
  const scheduler = new SchedulerService({ config: config.scheduler, planDir })
  await scheduler.savePlan(scheduler.generatePlan({ date: "2026-11-18", config: config.scheduler, profiles: [profile] }))
  let now = initial
  const calls = []
  let outcome = failedCommunity
  const service = new ScheduledSigninService({ scheduler, now: () => now, loadProfile: async () => profile,
    signin: { run: async args => { calls.push(args); return structuredClone(outcome) } }, notify: async () => ({ ok: true }) })
  return { scheduler, service, calls, setNow: value => { now = value }, setOutcome: value => { outcome = value },
    run: options => service.runDue({ now, config, ...options }), entry: async () => (await scheduler.getPlan("2026-11-18")).entries[0] }
}

test("community retry is persisted and never duplicates game signins", async t => {
  const f = await fixture(t)
  await f.run()
  let entry = await f.entry()
  assert.equal(entry.done, false)
  assert.equal(entry.nextRetryAt, undefined)
  assert.equal(entry.communityRetry.attempts, 0)
  f.setNow(new Date(2026, 10, 18, 4, 39))
  assert.equal((await f.run()).count, 0)
  f.setNow(new Date(2026, 10, 18, 4, 40))
  f.setOutcome(successCommunity)
  await f.run()
  assert.deepEqual(f.calls[1].communityRetryForums, [2])
  assert.equal(f.calls[1].source, "scheduled_community_retry")
  entry = await f.entry()
  assert.equal(entry.done, true)
  assert.equal(entry.ok, true)
  assert.equal(entry.communityRetry, undefined)
  assert.equal((await f.run()).count, 0)
})

test("full-task retries and community retries coexist without starving full retries", async t => {
  const f = await fixture(t)
  const mixed = structuredClone(failedCommunity)
  mixed.result.tasks.push({ kind: "game", key: "gs", status: "failed" })
  f.setOutcome(mixed)
  await f.run()
  assert.ok((await f.entry()).nextRetryAt)
  f.setNow(new Date(2026, 10, 18, 4, 40))
  f.setOutcome(successCommunity)
  await f.run()
  assert.equal((await f.entry()).ok, false)
  assert.equal((await f.entry()).done, false)
  f.setNow(new Date(2026, 10, 18, 4, 45))
  await f.run()
  assert.equal(f.calls[2].communityRetryForums, undefined)
  assert.equal((await f.entry()).done, true)
})

test("final community cron skips ordinary entries and stops retries at cutoff", async t => {
  const f = await fixture(t, new Date(2026, 10, 18, 23, 40))
  assert.equal((await f.run({ communityRetriesOnly: true })).count, 0)
  await f.run()
  f.setNow(new Date(2026, 10, 18, 23, 50))
  await f.run({ communityRetriesOnly: true })
  assert.equal((await f.entry()).communityRetry, undefined)
  assert.equal((await f.entry()).done, true)
  f.setNow(new Date(2026, 10, 19, 0, 1))
  assert.equal((await f.run({ date: "2026-11-18" })).count, 0)
})

test("manual full catchup replaces stale community state and preserves streaming result callbacks", async t => {
  const f = await fixture(t)
  await f.run()
  let callbacks = 0
  f.setOutcome(successCommunity)
  await f.service.runAll({ now: new Date(2026, 10, 18, 5), config, profiles: [profile], onResult: async () => { callbacks += 1 } })
  assert.equal(callbacks, 1)
  assert.equal((await f.entry()).communityRetry, undefined)
  assert.equal((await f.entry()).done, true)
})

test("community retry forwards cancellation and skips image rendering while retaining audit", async () => {
  let options, audits = 0
  const service = new ProfileSigninService({ runner: { runProfile: async (_, args) => { options = args; return { ok: true } } },
    appendAudit: async () => { audits += 1 }, renderSigninResult: async () => { throw new Error("must not render") }, beforeRequest: async () => {} })
  const controller = new AbortController()
  const result = await service.run({ qq: "10001", profile, refresh: false, communityRetryForums: [2], signal: controller.signal, source: "scheduled_community_retry" })
  assert.deepEqual(options.communityRetryForums, [2])
  controller.abort()
  assert.equal(options.signal.aborted, true)
  assert.equal(result.image, null)
  assert.equal(audits, 1)
})

test("auto redeem remains opt-in and does not query or redeem for default profiles", async () => {
  let calls = 0
  const worker = new AutoPreviewRedeem({ profiles: async () => [profile], lookup: { query: async () => { calls += 1 } } })
  await worker.run()
  assert.equal(calls, 0)
})

test("new web settings preserve fork configuration and the example remains valid", async () => {
  const cfg = createDefaultGlobalConfig()
  cfg.tools.auto_install = false
  cfg.captcha.test_nine.auto_start = false
  cfg.bilibili.download.use_aria2 = true
  const migrated = migrateGlobalConfig(cfg)
  assert.equal(migrated.tools.auto_install, false)
  assert.equal(migrated.captcha.test_nine.auto_start, false)
  assert.equal(migrated.bilibili.download.use_aria2, true)
  assert.deepEqual(validateGlobalConfig(migrated), [])
  const example = YAML.parse(await fs.readFile(new URL("../config/global.example.yaml", import.meta.url), "utf8"))
  assert.deepEqual(validateGlobalConfig(migrateGlobalConfig(example)), [])
})

test("Star Rail concurrent update lock releases after failure and retains overseas language", async () => {
  const service = new StarRailGachaService()
  let unblock, received
  service.sync = args => { received = args; return new Promise(resolve => { unblock = resolve }) }
  const args = { qq: "10001", uid: "800000001", region: "prod_official_asia", cookie: "os", lang: "ja-jp" }
  const first = service.updateByCookie(args)
  await assert.rejects(service.updateByCookie(args), /正在更新/)
  assert.equal(received.lang, "ja-jp")
  unblock({ ok: true })
  await first
  service.sync = async () => { throw new Error("fixture failure") }
  await assert.rejects(service.updateByCookie(args), /fixture failure/)
  service.sync = async () => ({ ok: true })
  assert.equal((await service.updateByCookie(args)).ok, true)
})

test("temporary refresh failure during a community retry retains the pending forums", async t => {
  const f = await fixture(t)
  await f.run()
  f.setNow(new Date(2026, 10, 18, 4, 40))
  f.setOutcome({ ok: false, stage: "refresh", profile, message: "temporary network failure" })
  await f.run()
  const entry = await f.entry()
  assert.deepEqual(entry.communityRetry.forums, [2])
  assert.equal(entry.communityRetry.attempts, 1)
  assert.equal(entry.nextRetryAt, undefined)
})

test("a full retry is not blocked by a later pending community retry", async t => {
  const f = await fixture(t)
  const mixed = structuredClone(failedCommunity)
  mixed.result.tasks.push({ kind: "game", key: "gs", status: "failed" })
  f.setOutcome(mixed)
  await f.run()
  f.setNow(new Date(2026, 10, 18, 4, 40))
  f.setOutcome(failedCommunity)
  await f.run()
  f.setNow(new Date(2026, 10, 18, 4, 45))
  f.setOutcome(successCommunity)
  await f.run()
  assert.equal(f.calls[2].communityRetryForums, undefined)
})

test("late first attempts receive a final 23:59 community-only retry", async t => {
  const f = await fixture(t, new Date(2026, 10, 18, 23, 55))
  await f.run()
  assert.equal(new Date((await f.entry()).communityRetry.nextAt).getMinutes(), 59)
  f.setNow(new Date(2026, 10, 18, 23, 59))
  await f.run({ communityRetriesOnly: true })
  assert.equal((await f.entry()).done, true)
  assert.equal((await f.entry()).communityRetry, undefined)
})

test("external deadline cancels even an uncooperative runner and releases the priority gate", async () => {
  const controller = new AbortController()
  const service = new ProfileSigninService({ render: false, appendAudit: async () => {},
    beforeRequest: async () => {}, runner: { runProfile: async () => { controller.abort(); return new Promise(() => {}) } } })
  const result = await service.run({ qq: "10001", profile, refresh: false, communityRetryForums: [2], signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(globalThis.__LOTUS_SIGNIN_COORDINATOR__.active, 0)
})

test("temporary community mission-state read failure does not schedule full game replay", async t => {
  const f = await fixture(t)
  const outcome = structuredClone(failedCommunity)
  outcome.result.tasks = [{ kind: "missions", key: "before", status: "failed", retryable: true }]
  f.setOutcome(outcome)
  await f.run()
  assert.equal((await f.entry()).nextRetryAt, undefined)
  assert.deepEqual((await f.entry()).communityRetry.forums, [2])
})

test("manual rerun clears completed state before persisting its running marker", async t => {
  const f = await fixture(t)
  const plan = await f.scheduler.getPlan("2026-11-18")
  plan.entries[0].done = true
  plan.entries[0].doneAt = "2026-11-18T04:30:00"
  await f.scheduler.savePlan(plan)
  let running
  f.service.signin.run = async () => {
    running = await f.entry()
    return successCommunity
  }
  const result = await f.service.runAll({ config, profiles: [profile], now: new Date(2026, 10, 18, 5) })
  assert.equal(result.ok, true)
  assert.equal(running.done, false)
  assert.equal(running.doneAt, undefined)
  assert.ok(running.runningAt)
})

test("full retry delay begins after the job completes, not at the scan start", async t => {
  const f = await fixture(t)
  f.service.signin.run = async () => {
    f.setNow(new Date(2026, 10, 18, 4, 50))
    return { ok: false, stage: "timeout", profile, message: "fixture timeout" }
  }
  await f.service.runDue({ config })
  const entry = await f.entry()
  assert.equal(new Date(entry.nextRetryAt).getHours(), 5)
  assert.equal(new Date(entry.nextRetryAt).getMinutes(), 5)
})

test("queued profiles persist their actual start time instead of the first scan time", async t => {
  const f = await fixture(t)
  const plan = await f.scheduler.getPlan("2026-11-18")
  plan.entries.push({ ...plan.entries[0], profileId: 2 })
  await f.scheduler.savePlan(plan)
  let calls = 0
  let second
  f.service.signin.run = async () => {
    calls += 1
    if (calls === 1) f.setNow(new Date(2026, 10, 18, 4, 50))
    else {
      second = (await f.scheduler.getPlan("2026-11-18")).entries[1]
    }
    return successCommunity
  }
  const result = await f.service.runDue({ config })
  assert.equal(result.ok, true)
  assert.equal(calls, 2)
  assert.equal(new Date(second.runningAt).getMinutes(), 50)
})

test("a completion after midnight never leaves a notification retry in yesterday's plan", async t => {
  const f = await fixture(t, new Date(2026, 10, 18, 23, 50))
  const plan = await f.scheduler.getPlan("2026-11-18")
  plan.entries[0].notificationRetryAt = "2026-11-18T23:55:00"
  await f.scheduler.savePlan(plan)
  f.service.signin.run = async () => {
    f.setNow(new Date(2026, 10, 19, 0, 5))
    return successCommunity
  }
  f.service.notify = async () => ({ ok: false })
  await f.service.runDue({ config })
  const entry = await f.entry()
  assert.equal(entry.notificationRetryAt, undefined)
  assert.ok(entry.notificationExhaustedAt)
})
