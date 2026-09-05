# 抽卡记录-原神、星铁、绝区零

返回：[上一级](../daily-note.md) / [文档目录](../README.md) / [小功能索引](README.md) / [致谢与引用](../references.md)

## 功能特性

- 原神通过对应 profile 的 stoken 生成 `authkey`。
- 星铁使用 profile Cookie 登录官方抽卡统计活动，读取五星记录与各卡池抽数，不依赖 `authkey`。
- 绝区零优先使用 CK 直刷；只有获取或刷新抽卡链接时才生成 `authkey`。
- 星铁记录以官方稳定记录 ID 增量合并；重复更新不会重复叠加，活动 token 和 Cookie 不落盘。
- 星铁接口不提供完整三星、四星明细；Lotus 保存五星、累计已抽和当前垫抽，数据位于 `data/starRailGachaJson/<qq>/<uid>.json`。
- 星铁会按 UID/角色区服选择请求族：国服使用 `account.cookie`、`hkrpg_cn` 与米游社接口；美服、欧服、亚服、港澳台服使用 `games.os.cookie`、`games.os.lang`、`hkrpg_global` 与 HoYoLAB 接口。国际服 Cookie 失效时会要求重新绑定，不会误调用国服刷新流程。
- `data/starRailGachaJson` 是 Lotus 的唯一正式星铁抽卡数据源。借用 miao 模板渲染时只创建 `data/srJson/lotus-render-*` 临时目录，并在成功或失败后清理，不覆盖 miao 自己的 `data/srJson/<QQ>/<UID>` 抽卡记录。
- 缓存和数据路径都按 profile 对应的游戏 UID 区分。
- `更新全部抽卡记录` 会遍历当前用户全部可用 profile，依次处理原神、星铁和绝区零；最终以合并转发返回，一条 profile 对应一个节点，不再截断第 6 个之后的 profile。

## 指令用法

```text
#更新抽卡记录[profile]
*更新抽卡记录[profile]
#星铁更新抽卡记录[profile]
%更新抽卡记录[profile]
#绝区零刷新抽卡链接[profile]
#绝区零更新抽卡记录[profile]
#更新全部抽卡记录
#恢复星铁抽卡兼容数据[profile] 确认
#原神角色记录[profile]
#原神武器记录[profile]
#原神集录记录[profile]
#原神常驻记录[profile]
#原神全部记录[profile]
*星铁角色记录[profile]
*星铁角色联动记录[profile]
*星铁光锥记录[profile]
*星铁光锥联动记录[profile]
*星铁常驻记录[profile]
*星铁新手记录[profile]
*星铁全部记录[profile]
```

## 变量说明

- `profile`：可选，Lotus 内部 profile 序号，范围 `1..255`；普通单 profile 指令省略时会按 profile 1 的同一路由执行。
- 原神查看命令使用 `#` 前缀；星铁查看命令沿用 `*` 前缀。查看前应先执行对应的更新命令，指定后缀时只读取该 profile 当前绑定的游戏 UID。

## 与其他插件共存

- 带 profile 后缀的查询（例如 `*星铁角色记录4`）明确由 Lotus 处理。
- 不带 profile 后缀的重叠个人查询始终交给其他插件优先处理；历史 `compatibility.conflict_takeover` 值不会改变这一规则。
- 批量更新指令 `#更新全部抽卡记录` 属于 Lotus 独立指令，不受上述开关影响。

## 历史兼容数据恢复

早期兼容实现可能在首次覆盖前留下 `data/srJson.backup/<QQ>/<UID>`。只有确实要把该冷备恢复到 miao 正式目录时，才发送：

```text
#恢复星铁抽卡兼容数据4 确认
```

恢复采用三步保护：先完整复制冷备到临时目录，再把当前 `data/srJson/<QQ>/<UID>` 保存到带时间戳的 `data/srJson.pre-restore/`，最后切换目标目录。最终切换失败时会立即从安全备份恢复原目录；若连自动恢复也失败，错误信息会给出仍然保留的安全备份路径。没有 `确认`、没有对应备份或路径校验失败时均不会替换。日常更新与查看不需要执行此命令。

## 验证要点

1. 更新前记录 miao 正式目录的哈希；执行 `*更新抽卡记录[profile]` 后，该目录哈希应保持不变。
2. 执行星铁查看指令后，`data/srJson` 下不应残留 `lotus-render-*`。
3. 国际服 profile 的日志应显示对应 `prod_official_usa/euro/asia/cht`，请求使用 `hkrpg_global`。
4. 建立 7 个以上 profile 后执行 `#更新全部抽卡记录`，转发结果应包含每个 profile 的三游戏状态。
5. 合并转发不可用时会完整逐条发送相同节点，不会丢弃失败原因。
