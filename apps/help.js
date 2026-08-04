const BasePlugin = globalThis.plugin

import { renderTemplate } from "../core/render/service.js"
import { replyImage } from "../core/transport/reply.js"
import { HELP_DOCUMENT_URL, loadHelpCommandSections } from "../services/help/commands.js"

export class LotusHelp extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Help",
      dsc: "Lotus command help",
      event: "message",
      priority: 20,
      rule: [
        { reg: "^#?(Lotus|lotus|荷花)(帮助|help)$", fnc: "help" },
        { reg: "^#自动签到帮助$", fnc: "help" },
      ],
    })
  }

  async help() {
    const sections = await loadHelpCommandSections()
    const image = await renderTemplate("help", {
      title: "荷花插件指令帮助",
      subtitle: `共 ${sections.reduce((sum, section) => sum + section.commands.length, 0)} 条指令/用法`,
      badge: "HELP",
      message: "profile 后缀支持 1..255；省略时使用 profile 1。下列内容直接读取插件仓库内的指令文档。",
      userId: this.e?.user_id || "user",
      sections: sections.map(section => ({ title: section.title, body: section.commands.join("\n") })),
      documentUrl: HELP_DOCUMENT_URL,
    }, { saveId: `lotus-help-${this.e?.user_id || "user"}` })
    await replyImage(this, image, "[荷花插件]指令帮助已生成。")
    return true
  }
}
