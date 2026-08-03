import assert from "node:assert/strict"
import test from "node:test"
import {
  BackgroundRefreshRetryService,
  normalizeBackgroundRetryDelays,
} from "../services/render/backgroundRetry.js"

function fakeScheduler() {
  const jobs = []
  return {
    jobs,
    schedule(callback, delayMs) {
      const job = { callback, delayMs, cancelled: false, unref() {} }
      jobs.push(job)
      return job
    },
    cancel(job) {
      job.cancelled = true
    },
    async runNext() {
      const job = jobs.shift()
      assert.ok(job)
      if (!job.cancelled) return job.callback()
    },
  }
}

function retryConfig(delays = [10, 30, 60], enable = true) {
  return { render: { background_retry_enable: enable, background_retry_delays_minutes: delays } }
}

test("background refresh retries with configured progressive delays until success", async () => {
  const scheduler = fakeScheduler()
  let attempts = 0
  const service = new BackgroundRefreshRetryService({
    refresh: async () => {
      attempts += 1
      if (attempts < 3) throw new Error(`network-${attempts}`)
      return { ok: true, files: Array(10).fill("local") }
    },
    loadConfig: async () => retryConfig(),
    schedule: scheduler.schedule.bind(scheduler),
    cancel: scheduler.cancel.bind(scheduler),
    logger: {},
  })

  const first = await service.start()
  assert.equal(first.retryScheduled, true)
  assert.equal(scheduler.jobs[0].delayMs, 10 * 60 * 1000)
  const second = await scheduler.runNext()
  assert.equal(second.retryScheduled, true)
  assert.equal(scheduler.jobs[0].delayMs, 30 * 60 * 1000)
  const recovered = await scheduler.runNext()
  assert.equal(recovered.ok, true)
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.attempt, 3)
  assert.equal(attempts, 3)
})

test("retry chain stops after all configured same-day delays are exhausted", async () => {
  const scheduler = fakeScheduler()
  let attempts = 0
  const service = new BackgroundRefreshRetryService({
    refresh: async () => { attempts += 1; throw new Error("offline") },
    loadConfig: async () => retryConfig([1, 2]),
    schedule: scheduler.schedule.bind(scheduler),
    cancel: scheduler.cancel.bind(scheduler),
    logger: {},
  })

  await service.start()
  await scheduler.runNext()
  const final = await scheduler.runNext()
  assert.equal(final.retryScheduled, false)
  assert.equal(final.attempt, 3)
  assert.equal(attempts, 3)
  assert.equal(scheduler.jobs.length, 0)
})

test("disabled retry strategy records failure without scheduling a timer", async () => {
  const scheduler = fakeScheduler()
  const service = new BackgroundRefreshRetryService({
    refresh: async () => { throw new Error("offline") },
    loadConfig: async () => retryConfig([10, 30], false),
    schedule: scheduler.schedule.bind(scheduler),
    cancel: scheduler.cancel.bind(scheduler),
    logger: {},
  })
  const result = await service.start()
  assert.equal(result.retryScheduled, false)
  assert.equal(scheduler.jobs.length, 0)
})

test("retry delay normalization accepts Guoba string arrays and rejects invalid entries", () => {
  assert.deepEqual(normalizeBackgroundRetryDelays(["5", "20", "60"]), [5, 20, 60])
  assert.deepEqual(normalizeBackgroundRetryDelays("5, 15\n45"), [5, 15, 45])
  assert.deepEqual(normalizeBackgroundRetryDelays([0, -1, 2000]), [10, 30, 60])
})
