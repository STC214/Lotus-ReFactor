# 抽卡记录-原神、星铁、绝区零

返回：[上一级](../daily-note.md) / [文档目录](../README.md) / [小功能索引](README.md) / [致谢与引用](../references.md)

## 功能特性

- 原神通过对应 profile 的 stoken 生成 `authkey`。
- 星铁使用 profile Cookie 登录官方抽卡统计活动，读取五星记录与各卡池抽数，不依赖 `authkey`。
- 绝区零优先使用 CK 直刷；只有获取或刷新抽卡链接时才生成 `authkey`。
- 星铁记录以官方稳定记录 ID 增量合并；重复更新不会重复叠加，活动 token 和 Cookie 不落盘。
- 星铁接口不提供完整三星、四星明细；Lotus 保存五星、累计已抽和当前垫抽，数据位于 `data/starRailGachaJson/<qq>/<uid>.json`。
- 缓存和数据路径都按 profile 对应的游戏 UID 区分。
- `更新全部抽卡记录` 会遍历当前用户可用 profile。

## 指令用法

```text
#更新抽卡记录[profile]
*更新抽卡记录[profile]
#星铁更新抽卡记录[profile]
%更新抽卡记录[profile]
#绝区零刷新抽卡链接[profile]
#绝区零更新抽卡记录[profile]
#更新全部抽卡记录
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
