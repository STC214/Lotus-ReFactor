import test from "node:test"
import assert from "node:assert/strict"
import { beginLotusSignin, runLotusNonSigninTask } from "../core/coordination/signinPriority.js"

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test("a pending sign-in waits for the current render and blocks the next render", async () => {
  const firstRenderGate = deferred()
  const signinGate = deferred()
  const events = []

  const firstRender = runLotusNonSigninTask(async () => {
    events.push("render-1-start")
    await firstRenderGate.promise
    events.push("render-1-end")
  })
  await new Promise(resolve => setImmediate(resolve))

  const signin = (async () => {
    const release = await beginLotusSignin()
    events.push("signin-start")
    await signinGate.promise
    events.push("signin-end")
    release()
  })()
  const secondRender = runLotusNonSigninTask(async () => {
    events.push("render-2")
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ["render-1-start"])
  firstRenderGate.resolve()
  await firstRender
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ["render-1-start", "render-1-end", "signin-start"])
  signinGate.resolve()
  await Promise.all([signin, secondRender])
  assert.deepEqual(events, ["render-1-start", "render-1-end", "signin-start", "signin-end", "render-2"])
})
