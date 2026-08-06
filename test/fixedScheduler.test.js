import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import YAML from "yaml"

import { validateGlobalConfig, validateProfile } from "../core/config/schema.js"
import { createDefaultGlobalConfig } from "../core/config/defaults.js"
import { GUOBA_SCHEMAS, applyGuobaFormData, toGuobaFormData } from "../guoba.support.js"
import { SchedulerService, planDateForGeneration } from "../core/scheduler/service.js"
import { ScheduledSigninService } from "../services/checkin/scheduled.js"

const schedulerConfig = {
  mode: "fixed",
  fixed_time: "04:30",
  entry_timeout_minutes: 1,
  running_timeout_minutes: 2,
  failure_retry_minutes: [15, 60],
  random: { window_start: "00:00", window_end: "23:30", notify_before: true },
  late_registration: { enable: true, window_start: "23:30", window_end: "23:59", notify: true },
}

function profile(id = 1, overrides = {}) {
  return {
    enabled: true,
    user: { qq: "10001", nickname: "test" },
    profile: { id, name: `P${id}`, notify: { prefer: "private", fallback_groups: [] } },
    account: { cookie: "cookie" },
    schedule: { mode: "inherit", allow_random: true },
    ...overrides,
  }
}

async function fixture(t) {
  const planDir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-fixed-scheduler-"))
  t.after(() => fs.rm(planDir, { recursive: true, force: true }))
  return new SchedulerService({ config: schedulerConfig, planDir })
}

test("plan date follows the configured generation-time half-day boundary", () => {
  const now = new Date(2026, 7, 4, 18, 30, 0)
  assert.equal(planDateForGeneration(now, "0 0 0 * * * *"), "2026-08-04")
  assert.equal(planDateForGeneration(now, "59 59 12 * * * *"), "2026-08-04")
  assert.equal(planDateForGeneration(now, "0 0 13 * * * *"), "2026-08-05")
  assert.equal(planDateForGeneration(now, "59 59 23 * * * *"), "2026-08-05")
  assert.equal(planDateForGeneration(now, "0 29 6 * * * *", "06:30"), "2026-08-04")
  assert.equal(planDateForGeneration(now, "0 30 6 * * * *", "06:30"), "2026-08-05")
})

test("plan date cutoff is configurable and exposed in Guoba", () => {
  const config = createDefaultGlobalConfig()
  assert.equal(config.scheduler.plan_date_cutoff_time, "13:00")
  assert.deepEqual(validateGlobalConfig(config), [])
  const schema = GUOBA_SCHEMAS.find(item => item.field === "scheduler.plan_date_cutoff_time")
  assert.equal(schema?.component, "Input")
  assert.equal(GUOBA_SCHEMAS.some(item => item.field === "scheduler.enable"), false)
})

test("Guoba renders 24-hour time fields and persists 7-field cron", () => {
  const config = createDefaultGlobalConfig()
  config.scheduler.plan_generate_cron = "0 30 23 * * ? *"
  const form = toGuobaFormData(config)
  assert.equal(form.scheduler.plan_generate_cron, "0 30 23 * * * *")
  const schema = GUOBA_SCHEMAS.find(item => item.field === "scheduler.fixed_time")
  assert.equal(schema?.componentProps?.type, "time")
  assert.equal(schema?.componentProps?.format, "HH:mm")
  const next = applyGuobaFormData(config, { scheduler: { plan_generate_cron: "30 23 * * *" } })
  assert.equal(next.scheduler.plan_generate_cron, "0 30 23 * * * *")
})

test("fixed plan respects global time and profile override", async t => {
  const scheduler = await fixture(t)
  const plan = scheduler.generatePlan({
    date: "2026-08-03",
    config: schedulerConfig,
    profiles: [profile(1), profile(2, { schedule: { mode: "fixed", fixed_time: "05:12" } })],
  })
  assert.deepEqual(plan.entries.map(item => item.time), ["04:30", "05:12"])
})

test("an existing due entry executes exactly once", async t => {
  const scheduler = await fixture(t)
  await scheduler.savePlan(scheduler.generatePlan({
    date: "2026-08-03",
    config: schedulerConfig,
    profiles: [profile()],
  }))
  let calls = 0
  const service = new ScheduledSigninService({
    scheduler,
    loadProfile: async () => profile(),
    signin: { run: async args => ({ ok: true, stage: "checkin", source: args.source, profile: profile(), image: "image", message: "ok" }) },
    notify: async () => ({ ok: true }),
  })
  service.signin.run = async args => {
    calls += 1
    return { ok: true, stage: "checkin", source: args.source, profile: profile(), image: "image", message: "ok" }
  }
  const now = new Date(2026, 7, 3, 4, 30, 0)
  const first = await service.runDue({ now, config: { scheduler: schedulerConfig }, profiles: [profile()] })
  const second = await service.runDue({ now, config: { scheduler: schedulerConfig }, profiles: [profile()] })
  assert.equal(first.createdPlan, false)
  assert.equal(first.count, 1)
  assert.equal(first.results[0].outcome.source, "scheduled")
  assert.equal(second.count, 0)
  assert.equal(calls, 1)
  const stored = await scheduler.getPlan("2026-08-03")
  assert.equal(stored.entries[0].done, true)
  assert.equal(stored.entries[0].resultNotified, true)
})

test("due scanning never creates a missing plan", async t => {
  const scheduler = await fixture(t)
  let calls = 0
  const service = new ScheduledSigninService({
    scheduler,
    signin: { run: async () => { calls += 1; return { ok: true } } },
  })
  const result = await service.runDue({
    now: new Date(2026, 7, 3, 4, 30),
    config: { scheduler: schedulerConfig },
    profiles: [profile()],
  })
  assert.equal(result.count, 0)
  assert.equal(result.reason, "plan_not_found")
  assert.equal(calls, 0)
  assert.equal(await scheduler.getPlan("2026-08-03"), null)
})

test("retryable failures use 15/60 minute backoff and persist each transition", async t => {
  const scheduler = await fixture(t)
  await scheduler.savePlan(scheduler.generatePlan({ date: "2026-08-03", config: schedulerConfig, profiles: [profile()] }))
  let calls = 0
  const service = new ScheduledSigninService({
    scheduler,
    loadProfile: async () => profile(),
    signin: { run: async () => ({ ok: ++calls >= 3, stage: "checkin", profile: profile(), message: calls >= 3 ? "ok" : "temporary" }) },
  })
  const options = { config: { scheduler: schedulerConfig }, profiles: [profile()], notify: false }
  const first = await service.runDue({ ...options, now: new Date(2026, 7, 3, 4, 30) })
  assert.equal(first.results[0].entry.nextRetryAt.includes("04:45:00"), true)
  assert.equal((await service.runDue({ ...options, now: new Date(2026, 7, 3, 4, 44) })).count, 0)
  const second = await service.runDue({ ...options, now: new Date(2026, 7, 3, 4, 45) })
  assert.equal(second.results[0].entry.nextRetryAt.includes("05:45:00"), true)
  const third = await service.runDue({ ...options, now: new Date(2026, 7, 3, 5, 45) })
  assert.equal(third.results[0].outcome.ok, true)
  assert.equal(third.results[0].entry.done, true)
  assert.equal(calls, 3)
})

test("retry does not spill into a plan date that will no longer be scanned", async t => {
  const config = { ...schedulerConfig, fixed_time: "23:55" }
  const scheduler = new SchedulerService({ config, planDir: (await fixture(t)).planDir })
  await scheduler.savePlan(scheduler.generatePlan({ date: "2026-08-03", config, profiles: [profile()] }))
  const service = new ScheduledSigninService({
    scheduler,
    loadProfile: async () => profile(),
    signin: { run: async () => ({ ok: false, stage: "runner", profile: profile(), message: "fail" }) },
  })
  const result = await service.runDue({
    now: new Date(2026, 7, 3, 23, 55),
    config: { scheduler: config },
    profiles: [profile()],
    notify: false,
  })
  assert.equal(result.results[0].entry.done, true)
  assert.equal("nextRetryAt" in result.results[0].entry, false)
})

test("stale running lease is recovered after restart", async t => {
  const scheduler = await fixture(t)
  const plan = scheduler.generatePlan({ date: "2026-08-03", config: schedulerConfig, profiles: [profile()] })
  plan.entries[0].runningAt = new Date(2026, 7, 3, 4, 0).toISOString()
  await scheduler.savePlan(plan)
  const service = new ScheduledSigninService({
    scheduler,
    loadProfile: async () => profile(),
    signin: { run: async () => ({ ok: true, stage: "checkin", profile: profile(), message: "ok" }) },
  })
  const result = await service.runDue({ now: new Date(2026, 7, 3, 4, 30), config: { scheduler: schedulerConfig }, notify: false })
  assert.equal(result.recovered, 1)
  assert.equal(result.count, 1)
  assert.equal(result.results[0].entry.recoveryCount, 1)
})

test("result notification failure never changes sign-in success and is retried without signing again", async t => {
  const scheduler = await fixture(t)
  await scheduler.savePlan(scheduler.generatePlan({ date: "2026-08-03", config: schedulerConfig, profiles: [profile()] }))
  let signinCalls = 0
  let notifyCalls = 0
  const service = new ScheduledSigninService({
    scheduler,
    loadProfile: async () => profile(),
    signin: { run: async () => ({ ok: true, stage: "checkin", profile: profile(), image: "image", message: "ok", call: ++signinCalls }) },
    notify: async () => {
      notifyCalls += 1
      if (notifyCalls === 1) throw new Error("transport down")
      return { ok: true }
    },
  })
  const options = { config: { scheduler: schedulerConfig }, profiles: [profile()] }
  const first = await service.runDue({ ...options, now: new Date(2026, 7, 3, 4, 30) })
  assert.equal(first.results[0].outcome.ok, true)
  assert.equal(first.results[0].entry.resultNotified, false)
  assert.equal(first.results[0].entry.notificationRetryAt.includes("04:45:00"), true)
  const retry = await service.runDue({ ...options, now: new Date(2026, 7, 3, 4, 45) })
  assert.equal(retry.count, 0)
  assert.equal(retry.notificationRetries.length, 1)
  assert.equal(retry.notificationRetries[0].sent.ok, true)
  assert.equal(signinCalls, 1)
  assert.equal(notifyCalls, 2)
})

test("plan save is readable after atomic replacement", async t => {
  const scheduler = await fixture(t)
  const plan = scheduler.generatePlan({ date: "2026-08-03", config: schedulerConfig, profiles: [profile()] })
  await scheduler.savePlan(plan)
  plan.entries[0].done = true
  await scheduler.savePlan(plan)
  assert.equal((await scheduler.getPlan("2026-08-03")).entries[0].done, true)
  assert.deepEqual((await fs.readdir(scheduler.planDir)).filter(name => name.endsWith(".tmp")), [])
})

test("plan notices isolate one transport failure and leave it retryable", async t => {
  const scheduler = await fixture(t)
  const plan = scheduler.generatePlan({ date: "2026-08-04", config: schedulerConfig, profiles: [profile(1), profile(2)] })
  let calls = 0
  const service = new ScheduledSigninService({
    scheduler,
    loadProfile: async (_qq, id) => profile(id),
    renderTemplate: async (_name, data) => `notice:${data.subtitle}`,
    notify: async () => (++calls === 1 ? Promise.reject(new Error("down")) : { ok: true }),
  })
  const results = await service.notifyPlan(plan)
  assert.equal(results.length, 2)
  assert.equal(results[0].sent.ok, false)
  assert.equal(results[1].sent.ok, true)
  assert.equal(plan.entries[0].notified, false)
  assert.equal(plan.entries[1].notified, true)
})

test("profile fixed time rejects out-of-range values", async () => {
  const example = YAML.parse(await fs.readFile(new URL("../config/profile.example.yaml", import.meta.url), "utf8"))
  example.enabled = true
  example.schedule.mode = "fixed"
  example.schedule.fixed_time = "99:99"
  assert.equal(validateProfile(example).includes("schedule.fixed_time must be HH:mm"), true)
})
