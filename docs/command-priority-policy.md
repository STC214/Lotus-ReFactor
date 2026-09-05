# 重叠命令优先级原则与升级检查清单

返回：[项目主页](../README.md) / [文档目录](README.md) / [兼容说明](compatibility.md)

## 不可变原则

当 Lotus-Plugin 与 Yunzai、miao-plugin 或其他插件能够匹配同一条用户指令时，**Lotus-Plugin 永远后处理**。其他插件先获得处理机会，Lotus 只作为末位兜底，不通过配置改变这一顺序。

该原则尤其适用于查询、面板、体力、角色资料、图鉴、攻略、抽卡记录、签到以及媒体解析等可能重叠的入口。它同时覆盖当前代码、以后新增的入口以及任何上游合并或版本升级。

## 允许与禁止

允许：

- `#荷花...` 等 Lotus 独有且不与其他插件重叠的命令正常执行；
- 带 Lotus 专用 profile 后缀且未被其他插件处理的命令由 Lotus 兜底；
- 自动签到、计划生成、后台缓存更新等非用户命令调度独立运行；
- 米游社验证码错误处理器使用独立的 handler 优先级。它不是用户查询命令，且失败后保留其他 handler 兜底。

禁止：

- 为普通 Lotus 命令设置比其他插件更早的优先级；
- 同优先级排序时把 Lotus 放到其他插件之前；
- 为了让 Lotus 抢占命令而禁用、删除或改写其他插件；
- 通过锅巴、YAML、环境变量或历史 `conflict_takeover` 配置重新启用普通命令接管；
- 上游合并时恢复上述任一行为。

## 代码约束

- 每个 `event: "message"` 的 Lotus 应用都必须直接使用 `LOTUS_INTERCEPT_PRIORITY = Number.POSITIVE_INFINITY`，不能只依赖运行时重排。Yunzai 按较小数值先执行，因此该值表示末位。
- `enforceLotusInterception()` 排序时会把每个 Lotus 加载条目视为末位优先级；数值相同的情况下仍把 Lotus 排到非 Lotus 插件之后。
- loader 暂时不可用时安装结果必须标记为可重试，不能提前写入“已安装”状态；启动延迟和 Bot online 阶段继续补偿安装。
- 历史 `compatibility.conflict_takeover` 字段只为读取旧配置而保留，运行时忽略，锅巴不再提供开关。
- 启动时只清理能够确认由旧版 Lotus 整体写入的禁用列表，不新增其他插件禁用项。
- `LOTUS_CAPTCHA_HANDLER_PRIORITY` 只允许用于 `mys.req.err` 验证码 handler，不得用于用户命令规则。

## 每次合并、升级必做检查

1. 搜索本次新增或变化的 `rule.reg`，列出与 Yunzai、miao-plugin 及已安装插件可能重叠的命令。
2. 搜索 `priority`、`conflict_takeover`、`disable`、`Handler.del`，确认没有普通命令抢占或禁用竞争插件。
3. 确认所有 Lotus 消息应用仍直接使用 `LOTUS_INTERCEPT_PRIORITY`，验证码 handler 只使用 `LOTUS_CAPTCHA_HANDLER_PRIORITY`；静态门禁测试必须通过。
4. 运行语法检查和完整测试：

   ```bash
   npm run check
   ```

5. 至少验证以下行为：
   - 构造同一命令、同一优先级的其他插件与 Lotus 条目，其他插件排在前面；
   - 普通优先级的其他插件排在 Lotus 前面；
   - 即使旧配置写着 `conflict_takeover: true`，无 profile 后缀查询仍交给其他插件；
   - Lotus 独有命令和明确 profile 后缀的兜底功能仍可执行；
   - 验证码 handler 失败后，其他 handler 仍保留。
6. 在合并说明或升级记录中写明“重叠命令优先级检查：通过”，未通过时不部署。

## 快速审计命令

在 Lotus 插件根目录执行：

```bash
grep -RIn --exclude-dir=node_modules --exclude-dir=resources \
  -E 'priority|conflict_takeover|Handler\.del|disable' apps core services guoba.support.js
node --test test/intercept-coexistence.test.js test/profile-query-takeover.test.js
```

Windows PowerShell 可执行：

```powershell
rg -n --glob '!node_modules/**' --glob '!resources/**' `
  'priority|conflict_takeover|Handler\.del|disable' apps core services guoba.support.js
node --test test/intercept-coexistence.test.js test/profile-query-takeover.test.js
```

## 回归判定

只有代码检查、定向测试和实际冲突命令验证全部通过，才允许合并、升级或部署。发现 Lotus 抢先响应时，应视为阻断性回归，而不是可选兼容模式。
