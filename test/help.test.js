import assert from "node:assert/strict"
import test from "node:test"

import { HELP_DOCUMENT_URL, loadHelpCommandSections, parseHelpCommandDocument } from "../services/help/commands.js"

test("help parser groups every documented backtick command", async () => {
  const sections = await loadHelpCommandSections()
  const commands = sections.flatMap(section => section.commands)
  assert.equal(sections.length > 10, true)
  assert.equal(commands.length > 100, true)
  assert.equal(commands.includes("#荷花帮助"), true)
  assert.equal(commands.includes("#生成签到计划"), true)
  assert.equal(commands.includes("#初始化工具环境"), true)
  assert.equal(commands.includes("#远程spawn <otp> <shell> <command>"), true)
})

test("help parser ignores prose and empty sections", () => {
  assert.deepEqual(parseHelpCommandDocument("## A\n说明\n- `#命令`\n## B\n没有命令"), [
    { title: "A", commands: ["#命令"] },
  ])
})

test("help document URL points to the repository command document", () => {
  assert.equal(HELP_DOCUMENT_URL, "https://github.com/STC214/Lotus-ReFactor/blob/main/docs/commands.md")
})
