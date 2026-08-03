import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
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
