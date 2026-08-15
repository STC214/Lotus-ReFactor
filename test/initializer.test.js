import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import YAML from "yaml"
import { applyUpdatePersistence, buildInitializationSummaryItems, ensureSubmodules, formatNetworkReport, mergeManagedGitHook, mergeWorkspacePolicy, normalizeSpawnCommand, probeDependencyNetwork, resolvePnpm, runLotusBootstrap, runProcess, validateSubmodules, withInitializationLock } from "../scripts/initialize-lotus.mjs"

test("initializer preserves workspace entries and merges native build policy", () => {
  const output = mergeWorkspacePolicy(`packages:\n  - plugins/*\nallowBuilds:\n  sharp: true\nonlyBuiltDependencies:\n  - sharp\n`)
  const parsed = YAML.parse(output)
  assert.deepEqual(parsed.packages, ["plugins/*"])
  assert.equal(parsed.allowBuilds.sharp, true)
  assert.equal(parsed.allowBuilds["skia-canvas"], true)
  assert.equal(parsed.allowBuilds.protobufjs, false)
  assert.deepEqual(parsed.onlyBuiltDependencies, ["sharp", "skia-canvas"])
})

test("initializer expands flow-style workspace policy without producing invalid YAML", () => {
  const output = mergeWorkspacePolicy(`packages: ["plugins/*"]\nallowBuilds: { sharp: true } # keep builds\nonlyBuiltDependencies: [sharp]\n`)
  const parsed = YAML.parse(output)
  assert.deepEqual(parsed.packages, ["plugins/*"])
  assert.deepEqual(parsed.allowBuilds, { sharp: true, "skia-canvas": true, protobufjs: false })
  assert.deepEqual(parsed.onlyBuiltDependencies, ["sharp", "skia-canvas"])
  assert.match(output, /# keep builds/)
})

test("network preflight records latency and keeps individual failures", async () => {
  const result = await probeDependencyNetwork({
    endpoints: [{ name: "fast", url: "https://fast" }, { name: "down", url: "https://down" }],
    fetchImpl: async url => {
      if (url.endsWith("down")) throw new Error("offline")
      return { ok: true, status: 200 }
    },
  })
  assert.equal(result[0].ok, true)
  assert.equal(result[1].ok, false)
  assert.equal(Number.isInteger(result[0].latencyMs), true)
  assert.match(formatNetworkReport(result), /魔法网络/)
  assert.match(formatNetworkReport(result), /fast：\d+ ms/)
})

test("fully unavailable dependency network stops before every mutating stage", async () => {
  const commands = []
  const result = await runLotusBootstrap({
    network: {
      endpoints: [{ name: "offline", url: "https://offline" }],
      fetchImpl: async () => { throw new Error("offline") },
    },
    runner: async (command, args) => {
      commands.push([command, ...args])
      return { code: 0, stdout: "", stderr: "" }
    },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.results.map(item => item.name), ["依赖网络"])
  assert.equal(result.restartRecommended, false)
  assert.deepEqual(commands, [])
  assert.match(formatNetworkReport(result.network), /修改文件和安装依赖前停止/)
})

test("progress notification failures never abort bootstrap state handling", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-event-failure-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const yunzai = path.join(root, "Yunzai")
  const plugin = path.join(root, "Outside-Lotus")
  await fs.mkdir(path.join(yunzai, ".git", "hooks"), { recursive: true })
  await fs.mkdir(plugin, { recursive: true })
  const result = await runLotusBootstrap({
    pluginRoot: plugin,
    yunzaiRoot: yunzai,
    network: { endpoints: [{ name: "fixture", url: "https://fixture" }], fetchImpl: async () => ({ ok: true, status: 200 }) },
    onEvent: async () => { throw new Error("transport unavailable") },
    runner: async (command, args) => ({
      code: 0,
      stdout: args.includes("--absolute-git-dir") ? `${path.join(yunzai, ".git")}\n` : args.includes("--git-path") ? `${path.join(yunzai, ".git", "hooks")}\n` : "",
      stderr: "",
    }),
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.results.map(item => item.name), ["依赖网络", "保存基线"])
})

test("custom process runner non-zero status rejects like a real child process", async () => {
  await assert.rejects(
    runProcess("fixture-command", ["arg"], { runner: async () => ({ code: 7, stdout: "", stderr: "fixture failure" }) }),
    /fixture-command arg exited 7: fixture failure/,
  )
})

test("final initialization summary retains every bootstrap and runtime stage", () => {
  const bootstrap = Array.from({ length: 9 }, (_, index) => ({ name: `bootstrap-${index}`, ok: true, value: "ok" }))
  const runtime = ["Python", "test_nine", "tools", "background", "atlas"].map(name => ({ name, ok: true, value: "ok" }))
  const items = buildInitializationSummaryItems(bootstrap, runtime, { restartRecommended: true })
  assert.equal(items.length, 16)
  for (const name of ["tools", "background", "atlas"]) assert.equal(items.some(item => item.label === name), true)
  assert.equal(items.at(-1).label, "重启")
})

test("managed Git hook preserves user commands, runs before exit and remains idempotent", () => {
  const first = mergeManagedGitHook("#!/bin/sh\necho user-hook\nexit 0\n")
  const second = mergeManagedGitHook(first)
  assert.equal(first, second)
  assert.match(first, /echo user-hook/)
  assert.equal((first.match(/>>> Lotus workspace policy/g) || []).length, 1)
  assert.match(first, /--workspace-policy-only/)
  assert.match(first, /lotus-workspace-policy\.status\.json/)
  assert.doesNotMatch(first, />>.*lotus-workspace-policy\.log/)
  assert.match(first, /LOTUS_POLICY_TMP="\$LOTUS_POLICY_LOG\.\$\$\.tmp"/)
  assert.doesNotMatch(first, /LOTUS_POLICY_LOG\.tmp/)
  assert.match(first, /--absolute-git-dir/)
  const custom = mergeManagedGitHook("", { pluginRelative: "plugins/Custom Lotus" })
  assert.match(custom, /LOTUS_PLUGIN_REL='plugins\/Custom Lotus'/)
  assert.match(custom, /\$LOTUS_PLUGIN_SCRIPT/)
  assert.equal(first.indexOf("Lotus workspace policy") < first.indexOf("exit 0"), true)
})

test("Git worktree layout installs hooks in the resolved Git path", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-worktree-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const plugin = path.join(root, "plugins", "Custom-Lotus")
  const gitDir = path.join(root, "resolved-git-dir")
  const hooksRoot = path.join(gitDir, "hooks")
  await fs.mkdir(plugin, { recursive: true })
  await fs.writeFile(path.join(root, ".git"), "gitdir: resolved-git-dir\n")
  const result = await applyUpdatePersistence({
    yunzaiRoot: root,
    pluginRoot: plugin,
    runner: async (command, args) => ({
      code: 0,
      stdout: args.includes("--absolute-git-dir") ? `${gitDir}\n` : args.includes("--git-path") ? `${hooksRoot}\n` : "",
      stderr: "",
    }),
  })
  assert.equal(result.ok, true)
  const hook = await fs.readFile(path.join(hooksRoot, "post-checkout"), "utf8")
  assert.match(hook, /LOTUS_PLUGIN_REL='plugins\/Custom-Lotus'/)
})

test("core.hooksPath wins when dot-git is a normal directory", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-custom-hooks-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const plugin = path.join(root, "plugins", "Lotus-Plugin")
  const hooksRoot = path.join(root, ".githooks")
  await fs.mkdir(path.join(root, ".git"), { recursive: true })
  await fs.mkdir(plugin, { recursive: true })
  await applyUpdatePersistence({
    yunzaiRoot: root,
    pluginRoot: plugin,
    runner: async (command, args) => ({
      code: 0,
      stdout: args.includes("--absolute-git-dir") ? `${path.join(root, ".git")}\n` : args.includes("--git-path") ? `${hooksRoot}\n` : "",
      stderr: "",
    }),
  })
  assert.equal(await fs.access(path.join(hooksRoot, "post-checkout")).then(() => true, () => false), true)
  assert.equal(await fs.access(path.join(root, ".git", "hooks", "post-checkout")).then(() => true, () => false), false)
})

test("pnpm selection follows the Yunzai packageManager declaration", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-pnpm-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const plugin = path.join(root, "plugins", "Lotus-Plugin")
  await fs.mkdir(plugin, { recursive: true })
  await fs.writeFile(path.join(root, "package.json"), '{"packageManager":"pnpm@9.15.1"}')
  await fs.writeFile(path.join(plugin, "package.json"), '{"packageManager":"pnpm@10.12.4"}')
  const selected = await resolvePnpm({ yunzai: root, plugin }, {
    runner: async (command, args) => ({ code: 0, stdout: command.includes("pnpm") && args[0] === "--version" ? "8.0.0\n" : "", stderr: "" }),
  })
  assert.deepEqual(selected.prefix, ["pnpm@9.15.1"])
})

test("standalone initialization lock rejects overlap and releases afterwards", async t => {
  const plugin = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-lock-"))
  t.after(() => fs.rm(plugin, { recursive: true, force: true }))
  let release
  const held = withInitializationLock(() => new Promise(resolve => { release = resolve }), { pluginRoot: plugin })
  while (!release) await new Promise(resolve => setTimeout(resolve, 1))
  const lock = path.join(plugin, "data", "initialization", "initialize.lock")
  const old = new Date(Date.now() - 3 * 60 * 60_000)
  await fs.utimes(lock, old, old)
  await assert.rejects(withInitializationLock(async () => {}, { pluginRoot: plugin }), /已有初始化进程持有锁/)
  release("done")
  assert.equal(await held, "done")
  assert.equal(await withInitializationLock(async () => "again", { pluginRoot: plugin }), "again")

  await fs.mkdir(path.dirname(lock), { recursive: true })
  await fs.writeFile(lock, JSON.stringify({ pid: 2_147_483_647, startedAt: new Date().toISOString() }))
  assert.equal(await withInitializationLock(async () => "dead-owner-recovered", { pluginRoot: plugin }), "dead-owner-recovered")
})

test("dead-lock takeover is serialized and never overlaps initializers", async t => {
  const plugin = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-lock-race-"))
  t.after(() => fs.rm(plugin, { recursive: true, force: true }))
  const lock = path.join(plugin, "data", "initialization", "initialize.lock")
  await fs.mkdir(path.dirname(lock), { recursive: true })
  await fs.writeFile(lock, JSON.stringify({ token: "dead-owner", pid: 2_147_483_647 }))
  let active = 0
  let maximum = 0
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => withInitializationLock(async () => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 20))
    active -= 1
  }, { pluginRoot: plugin, guardRetryMs: 1 })))
  assert.equal(maximum, 1)
  assert.equal(attempts.some(item => item.status === "fulfilled"), true)
  assert.equal(await fs.access(`${lock}.guard`).then(() => true, () => false), false)
})

test("Windows cmd wrappers launch through cmd.exe instead of direct spawn", async t => {
  const launch = normalizeSpawnCommand("corepack.cmd", ["--version"], "win32", "C:/Windows/System32/cmd.exe")
  assert.equal(launch.command, "C:/Windows/System32/cmd.exe")
  assert.deepEqual(launch.args.slice(0, 3), ["/d", "/s", "/c"])
  assert.equal(launch.spawnOptions.windowsVerbatimArguments, true)
  if (process.platform !== "win32") return
  const root = path.join(os.tmpdir(), `lotus cmd ${Date.now()}`)
  await fs.mkdir(root)
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const batch = path.join(root, "lotus test.cmd")
  await fs.writeFile(batch, '@echo off\r\necho A=["%~1"]\r\necho B=["%~2"]\r\necho C=["%~3"]\r\necho D=["%LOTUS_CUSTOM_ENV%"]\r\n')
  const result = await runProcess(batch, ["value with spaces", "a&b", "%PATH%"], {
    timeoutMs: 10_000,
    env: { ...process.env, LOTUS_CUSTOM_ENV: "preserved" },
  })
  assert.match(result.stdout, /A=\["value with spaces"\]/)
  assert.match(result.stdout, /B=\["a&b"\]/)
  assert.match(result.stdout, /C=\["%PATH%"\]/)
  assert.match(result.stdout, /D=\["preserved"\]/)
})

test("critical baseline failure stops every later mutating stage", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-gate-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const yunzai = path.join(root, "Yunzai")
  const plugin = path.join(root, "Outside-Lotus")
  await fs.mkdir(path.join(yunzai, ".git", "hooks"), { recursive: true })
  await fs.mkdir(plugin, { recursive: true })
  await fs.writeFile(path.join(yunzai, "pnpm-workspace.yaml"), "packages: []\n")
  await fs.writeFile(path.join(plugin, "package.json"), "{}")
  const commands = []
  const result = await runLotusBootstrap({
    pluginRoot: plugin,
    yunzaiRoot: yunzai,
    network: { endpoints: [{ name: "fixture", url: "https://fixture" }], fetchImpl: async () => ({ ok: true, status: 200 }) },
    runner: async (command, args) => {
      commands.push([command, ...args])
      if (args.includes("--absolute-git-dir")) return { code: 0, stdout: `${path.join(yunzai, ".git")}\n`, stderr: "" }
      if (args.includes("--git-path")) return { code: 0, stdout: `${path.join(yunzai, ".git", "hooks")}\n`, stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.results.map(item => item.name), ["依赖网络", "保存基线"])
  assert.equal(commands.some(item => item.includes("install") || item.includes("clone")), false)
  assert.equal(await fs.access(path.join(plugin, "data")).then(() => true, () => false), false)
})

test("failed baseline capture removes its partial backup generation", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-baseline-atomic-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const yunzai = path.join(root, "Yunzai")
  const plugin = path.join(yunzai, "plugins", "Lotus-Plugin")
  await fs.mkdir(path.join(yunzai, ".git", "hooks"), { recursive: true })
  await fs.mkdir(plugin, { recursive: true })
  await fs.mkdir(path.join(yunzai, "pnpm-workspace.yaml"))
  const result = await runLotusBootstrap({
    pluginRoot: plugin,
    yunzaiRoot: yunzai,
    network: { endpoints: [{ name: "fixture", url: "https://fixture" }], fetchImpl: async () => ({ ok: true, status: 200 }) },
    runner: async (command, args) => ({
      code: 0,
      stdout: args.includes("--absolute-git-dir") ? `${path.join(yunzai, ".git")}\n` : args.includes("--git-path") ? `${path.join(yunzai, ".git", "hooks")}\n` : "",
      stderr: "",
    }),
  })
  assert.equal(result.ok, false)
  assert.match(result.results.at(-1).value, /不是普通文件/)
  const backups = path.join(plugin, "data", "initialization", "backups")
  assert.deepEqual(await fs.readdir(backups), [])
})

test("QQ initializer gates runtime services on bootstrap success", async () => {
  const source = await fs.readFile(new URL("../apps/initializer.js", import.meta.url), "utf8")
  assert.equal((source.match(/if \(bootstrap\.ok\) await runRuntime/g) || []).length, 5)
})

test("failed ZIP-style clone removes its temporary directory", async t => {
  const plugin = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-atomic-clone-"))
  t.after(() => fs.rm(plugin, { recursive: true, force: true }))
  await assert.rejects(ensureSubmodules({ plugin }, {
    runner: async (command, args) => {
      if (command === "git" && args[0] === "clone") {
        await fs.mkdir(args.at(-1), { recursive: true })
        await fs.writeFile(path.join(args.at(-1), "partial"), "broken")
        throw new Error("network interrupted")
      }
      return { code: 0, stdout: "", stderr: "" }
    },
  }), /network interrupted/)
  assert.equal((await fs.readdir(plugin)).some(name => name.includes(".lotus-init-")), false)
})

test("ZIP-style source installs missing submodules and creates runnable rollback", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-zip-init-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const yunzai = path.join(root, "Yunzai")
  const plugin = path.join(yunzai, "plugins", "Custom-Lotus")
  await fs.mkdir(path.join(yunzai, "plugins", "Guoba-Plugin"), { recursive: true })
  await fs.writeFile(path.join(yunzai, "plugins", "Guoba-Plugin", "package.json"), "{}")
  await runProcess("git", ["init", "-b", "main"], { cwd: path.join(yunzai, "plugins", "Guoba-Plugin"), timeoutMs: 10_000 })
  await runProcess("git", ["config", "user.email", "lotus-test@example.invalid"], { cwd: path.join(yunzai, "plugins", "Guoba-Plugin"), timeoutMs: 10_000 })
  await runProcess("git", ["config", "user.name", "Lotus Test"], { cwd: path.join(yunzai, "plugins", "Guoba-Plugin"), timeoutMs: 10_000 })
  await runProcess("git", ["add", "package.json"], { cwd: path.join(yunzai, "plugins", "Guoba-Plugin"), timeoutMs: 10_000 })
  await runProcess("git", ["commit", "-m", "fixture"], { cwd: path.join(yunzai, "plugins", "Guoba-Plugin"), timeoutMs: 10_000 })
  await fs.mkdir(plugin, { recursive: true })
  await fs.writeFile(path.join(plugin, "package.json"), '{"packageManager":"pnpm@10.12.4"}')
  await fs.writeFile(path.join(yunzai, "pnpm-workspace.yaml"), "packages:\n  - plugins/*\n")
  const markers = {
    MihoyoBBSTools: ["requirements.txt", "main.py"],
    test_nine: ["requirements_without_train.txt", "main.py", "predict.py"],
    "nanoka-atlas-backend": ["package.json", "src/scrape.mjs"],
  }
  const result = await runLotusBootstrap({
    pluginRoot: plugin,
    yunzaiRoot: yunzai,
    network: { endpoints: [{ name: "fixture", url: "https://fixture" }], fetchImpl: async () => ({ ok: true, status: 200 }) },
    runner: async (command, args) => {
      if (command === "git" && args[0] === "clone") {
        const target = args.at(-1)
        const name = path.basename(target)
        const component = Object.keys(markers).find(key => name.startsWith(`${key}.lotus-init-`))
        for (const file of markers[component]) {
          await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true })
          await fs.writeFile(path.join(target, file), component)
        }
      }
      return { code: 0, stdout: args[0] === "--version" ? "10.12.4\n" : "", stderr: "" }
    },
    nodeDependencyCheck: async () => ({ ok: true, value: "fixture" }),
  })
  assert.equal(result.results.find(item => item.name === "Git 子模块").ok, true)
  assert.equal(result.results.find(item => item.name === "Git 子模块").changed, true)
  const backup = result.results.find(item => item.name === "保存基线").value.match(/^(.*?)（/)[1]
  assert.equal(await fs.readFile(path.join(backup, "rollback.mjs"), "utf8").then(text => text.includes("baseline and node_modules restored")), true)
  await runProcess(process.execPath, ["--check", path.join(backup, "rollback.mjs")], { timeoutMs: 10_000 })
  const manifest = JSON.parse(await fs.readFile(path.join(backup, "baseline.json"), "utf8"))
  assert.equal(manifest.files.some(item => item.relative === "pnpm-lock.yaml"), true)
  assert.equal(manifest.directories.some(item => item.relative === "plugins/Custom-Lotus/MihoyoBBSTools" && !item.existed), true)
  const rollback = await fs.readFile(path.join(backup, "rollback.mjs"), "utf8")
  assert.match(rollback, /item\.gitBranch/)
  assert.match(rollback, /!item\.dirty/)
  assert.match(rollback, /manifest\.pluginRoot/)
  assert.match(rollback, /directVersion !== declared/)
  await runProcess(process.execPath, [path.join(backup, "rollback.mjs"), "--skip-dependencies"], { timeoutMs: 30_000 })
  const guobaBranch = await runProcess("git", ["branch", "--show-current"], { cwd: path.join(yunzai, "plugins", "Guoba-Plugin"), timeoutMs: 10_000 })
  assert.equal(guobaBranch.stdout.trim(), "main")
  assert.equal(await fs.access(path.join(plugin, "MihoyoBBSTools")).then(() => true, () => false), false)
})

test("QQ initializer uses the same filesystem lock as standalone CLI", async () => {
  const source = await fs.readFile(new URL("../apps/initializer.js", import.meta.url), "utf8")
  assert.match(source, /withInitializationLock\(\(\) => this\.runInitialization\(config\)\)/)
})

test("initializer command timeout rejects even when the child ignores SIGTERM", async () => {
  const started = Date.now()
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
      timeoutMs: 50,
      killGraceMs: 50,
    }),
    /timed out after 50ms/,
  )
  assert.equal(Date.now() - started < 2_000, true)
})

test("timeout force-kills descendants when the process leader exits on SIGTERM", async t => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-timeout-tree-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const pidFile = path.join(root, "child.pid")
  const childCode = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
  const leaderCode = `const fs=require('fs'),{spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`
  await assert.rejects(runProcess(process.execPath, ["-e", leaderCode, pidFile], {
    timeoutMs: 100,
    killGraceMs: 100,
  }), /timed out after 100ms/)
  const pid = Number(await fs.readFile(pidFile, "utf8"))
  await new Promise(resolve => setTimeout(resolve, 100))
  let alive = true
  try {
    process.kill(pid, 0)
    if (process.platform === "linux") {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
      alive = stat ? stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z" : false
    }
  } catch (error) {
    alive = error.code === "EPERM"
  }
  if (alive) {
    try { process.kill(pid, "SIGKILL") } catch {}
  }
  assert.equal(alive, false)
})

test("submodule validation rejects non-empty but incomplete directories", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-submodules-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const name of ["MihoyoBBSTools", "test_nine", "nanoka-atlas-backend"]) {
    await fs.mkdir(path.join(root, name), { recursive: true })
    await fs.writeFile(path.join(root, name, "README.md"), "incomplete")
  }
  const result = await validateSubmodules(root)
  assert.equal(result.ok, false)
  assert.equal(result.missing.some(item => item.includes("requirements.txt")), true)
  assert.equal(result.missing.some(item => item.includes("src/scrape.mjs")), true)
})

test("full bootstrap follows runbook order and is idempotent over existing components", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-init-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const yunzai = path.join(root, "Yunzai")
  const plugin = path.join(yunzai, "plugins", "Lotus-Plugin")
  await fs.mkdir(path.join(yunzai, ".git", "hooks"), { recursive: true })
  await fs.mkdir(path.join(yunzai, "plugins", "Guoba-Plugin"), { recursive: true })
  await fs.writeFile(path.join(yunzai, "plugins", "Guoba-Plugin", "package.json"), "{}")
  const submoduleFiles = {
    MihoyoBBSTools: ["requirements.txt", "main.py"],
    test_nine: ["requirements_without_train.txt", "main.py", "predict.py"],
    "nanoka-atlas-backend": ["package.json", "src/scrape.mjs"],
  }
  for (const [name, files] of Object.entries(submoduleFiles)) {
    for (const file of files) {
      const target = path.join(plugin, name, file)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, name)
    }
  }
  await fs.writeFile(path.join(plugin, "package.json"), '{"name":"lotus-fixture"}')
  await fs.writeFile(path.join(yunzai, "pnpm-workspace.yaml"), "packages:\n  - plugins/*\nallowBuilds:\n  sharp: true\n")
  const events = []
  const commands = []
  const result = await runLotusBootstrap({
    pluginRoot: plugin,
    yunzaiRoot: yunzai,
    network: {
      endpoints: [{ name: "fixture", url: "https://fixture" }],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    },
    runner: async (command, args) => {
      commands.push([command, ...args])
      if (command === "git" && args.includes("--absolute-git-dir")) {
        return { code: 0, stdout: `${path.join(yunzai, ".git")}\n`, stderr: "" }
      }
      if (command === "git" && args.includes("--git-path")) {
        return { code: 0, stdout: `${path.join(yunzai, ".git", "hooks")}\n`, stderr: "" }
      }
      return { code: 0, stdout: command, stderr: "" }
    },
    nodeDependencyCheck: async () => ({ ok: true, value: "fixture dependencies" }),
    onEvent: event => events.push(event),
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.results.slice(1).map(item => item.name), [
    "保存基线", "系统组件", "锅巴插件", "Git 子模块", "pnpm 构建策略", "更新持久化保护", "Node 依赖", "skia-canvas", "基础验收",
  ])
  assert.equal(events[0].type, "network")
  assert.equal(commands.some(item => item.includes("install") && item.includes("--ignore-scripts=false")), true)
  const workspace = YAML.parse(await fs.readFile(path.join(yunzai, "pnpm-workspace.yaml"), "utf8"))
  assert.equal(workspace.allowBuilds.sharp, true)
  assert.equal(workspace.allowBuilds["skia-canvas"], true)
  const checkoutHook = await fs.readFile(path.join(yunzai, ".git", "hooks", "post-checkout"), "utf8")
  assert.match(checkoutHook, /Lotus workspace policy/)
  const installCount = commands.filter(item => item.includes("install") && item.includes("--ignore-scripts=false")).length
  const repeated = await runLotusBootstrap({
    pluginRoot: plugin,
    yunzaiRoot: yunzai,
    network: {
      endpoints: [{ name: "fixture", url: "https://fixture" }],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    },
    runner: async (command, args) => {
      commands.push([command, ...args])
      if (command === "git" && args.includes("--absolute-git-dir")) {
        return { code: 0, stdout: `${path.join(yunzai, ".git")}\n`, stderr: "" }
      }
      if (command === "git" && args.includes("--git-path")) {
        return { code: 0, stdout: `${path.join(yunzai, ".git", "hooks")}\n`, stderr: "" }
      }
      return { code: 0, stdout: command, stderr: "" }
    },
    nodeDependencyCheck: async () => ({ ok: true, value: "fixture dependencies" }),
  })
  assert.equal(commands.filter(item => item.includes("install") && item.includes("--ignore-scripts=false")).length, installCount)
  assert.equal(repeated.results.find(item => item.name === "Node 依赖").changed, false)
})
