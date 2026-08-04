import fs from "node:fs/promises"

export const HELP_DOCUMENT_URL = "https://github.com/STC214/Lotus-ReFactor/blob/main/docs/commands.md"

export async function loadHelpCommandSections(options = {}) {
  const markdown = options.markdown ?? await fs.readFile(
    options.documentPath || new URL("../../docs/commands.md", import.meta.url),
    "utf8",
  )
  return parseHelpCommandDocument(markdown)
}

export function parseHelpCommandDocument(markdown = "") {
  const sections = []
  let current = null
  for (const rawLine of String(markdown).split(/\r?\n/)) {
    const heading = rawLine.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      current = { title: heading[1].trim(), commands: [] }
      sections.push(current)
      continue
    }
    if (!current || !/^\s*-\s+/.test(rawLine)) continue
    const commands = [...rawLine.matchAll(/`([^`]+)`/g)]
      .map(match => match[1].trim())
      .filter(Boolean)
    current.commands.push(...commands)
  }
  return sections.filter(section => section.commands.length)
}
