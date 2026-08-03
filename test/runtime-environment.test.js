import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"
import {
  detectLibc,
  detectPythonEnvironment,
  detectRuntimeEnvironment,
  environmentKeys,
  normalizeArch,
  normalizePlatform,
  pythonCandidates,
  selectEnvironmentValue,
} from "../services/runtime/environment.js"
import { createPythonVenv, ensurePythonPip } from "../services/python/env.js"

test("normalizes operating systems and CPU architectures", () => {
  assert.equal(normalizePlatform("win32"), "windows")
  assert.equal(normalizePlatform("darwin"), "darwin")
  assert.equal(normalizePlatform("linux"), "linux")
  assert.equal(normalizeArch("x86_64"), "x64")
  assert.equal(normalizeArch("aarch64"), "arm64")
  assert.equal(normalizeArch("i686"), "x86")
})

test("detects libc and builds stable environment keys", () => {
  assert.equal(detectLibc({ header: { glibcVersionRuntime: "2.41" } }, "linux"), "glibc")
  assert.equal(detectLibc({ header: {} }, "linux"), "musl")
  const environment = detectRuntimeEnvironment({ platform: "linux", arch: "x86_64", libc: "glibc" })
  assert.equal(environment.key, "linux-x64-glibc")
  assert.deepEqual(environmentKeys(environment), ["linux-x64-glibc", "linux-x64", "linux", "default"])
  assert.equal(selectEnvironmentValue({ "linux-x64": "https://mirror/tool.zip" }, environment), "https://mirror/tool.zip")
})

test("orders Python candidates by explicit configuration then platform defaults", () => {
  assert.deepEqual(pythonCandidates({ platform: "win32", configured: "C:\\Python\\python.exe" }), [
    { command: "C:\\Python\\python.exe", args: [], source: "configured" },
    { command: "py", args: ["-3"], source: "launcher" },
    { command: "python", args: [], source: "path" },
    { command: "python3", args: [], source: "path" },
  ])
  assert.equal(pythonCandidates({ platform: "linux" })[0].command, "python3")
  assert.deepEqual(pythonCandidates({
    platform: "linux",
    configured: "/venv/bin/python",
    includeDefaults: false,
  }), [{ command: "/venv/bin/python", args: [], source: "configured" }])
})

test("probes Python candidates and rejects versions below the configured minimum", async () => {
  const spawn = fakeSpawn((command, args) => {
    assert.equal(args.at(-2), "-c")
    assert.match(args.at(-1), /import json,platform,sys;print/)
    if (command === "python3") return { code: 0, stdout: JSON.stringify({
      executable: "/usr/bin/python3",
      version: "3.9.18",
      implementation: "CPython",
      platform: "linux",
      machine: "x86_64",
      prefix: "/usr",
      base_prefix: "/usr",
    }) }
    return { code: 0, stdout: JSON.stringify({
      executable: "/opt/python/bin/python",
      version: "3.12.4",
      implementation: "CPython",
      platform: "linux",
      machine: "aarch64",
      prefix: "/opt/python",
      base_prefix: "/opt/python",
    }) }
  })
  const result = await detectPythonEnvironment({ platform: "linux", minimumVersion: "3.10", spawn })
  assert.equal(result.command, "python")
  assert.equal(result.version, "3.12.4")
  assert.equal(result.arch, "arm64")
  assert.match(result.attempts[0].reason, /3\.9\.18/)
})

test("bootstraps pip with official get-pip.py when ensurepip is unavailable", async () => {
  const calls = []
  const spawn = fakeSpawn((command, args) => {
    calls.push([command, ...args])
    if (args.includes("ensurepip")) return { code: 1, stderr: "No module named ensurepip" }
    if (args.at(-2) === "pip" && args.at(-1) === "--version") {
      const checks = calls.filter(item => item.includes("--version")).length
      return checks === 1
        ? { code: 1, stderr: "No module named pip" }
        : { code: 0, stdout: "pip 26.0 from test" }
    }
    if (args.some(value => String(value).includes("get-pip-"))) return { code: 0 }
    return { code: 1, stderr: "unexpected command" }
  })
  let requested = ""
  const result = await ensurePythonPip({
    python: { command: "/venv/bin/python", args: [] },
    spawnImpl: spawn,
    fetchImpl: async url => {
      requested = url
      return new Response("print('bootstrap pip')", { status: 200 })
    },
  })
  assert.equal(result.status, "bootstrapped")
  assert.equal(requested, "https://bootstrap.pypa.io/get-pip.py")
  assert.equal(calls.some(item => item.includes("ensurepip")), true)
  assert.equal(calls.some(item => item.some(value => String(value).includes("get-pip-"))), true)
})

test("creates a pipless venv when a distributor removes ensurepip", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-pipless-venv-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = []
  const spawn = fakeSpawn((_command, args) => {
    calls.push(args)
    return args.includes("--without-pip")
      ? { code: 0 }
      : { code: 1, stderr: "ensurepip is not available; install the python3.13-venv package" }
  })
  const result = await createPythonVenv({
    spawnImpl: spawn,
    systemPython: { command: "python3", args: [] },
    venvPath: path.join(dir, "venv"),
  })
  assert.equal(result.withoutPip, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].includes("--without-pip"), true)
})

function fakeSpawn(handler) {
  return (command, args) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}
    process.nextTick(() => {
      const result = handler(command, args)
      if (result.error) return child.emit("error", result.error)
      if (result.stdout) child.stdout.write(result.stdout)
      if (result.stderr) child.stderr.write(result.stderr)
      child.stdout.end()
      child.stderr.end()
      child.emit("close", result.code ?? 0)
    })
    return child
  }
}
