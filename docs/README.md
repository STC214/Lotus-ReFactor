# 荷花插件文档

这里是 `Lotus-Plugin ReFactor` 当前维护分支的详细说明。主 README 只放概览，本目录按大功能模块组织；每个模块下面再拆到具体小功能页。

- 当前维护仓库：[STC214/Lotus-ReFactor](https://github.com/STC214/Lotus-ReFactor)
- 上游来源仓库：[MOPELotus/Lotus-ReFactor](https://github.com/MOPELotus/Lotus-ReFactor)
- [致谢与引用](references.md)

## 安装与运行

- [荷花插件安装与故障处置运行手册（维护代理专用）](maintenance-runbook.md)
- [安装与部署](installation.md)
- [LLBot 部署、升级与大文件发送](llbot.md)
- [兼容与接管模式](compatibility.md)
- [Guoba 设置页完整使用手册](guoba-settings.md)
- [初始化](initialization.md)
  - [工具链-BBDown/ffmpeg/aria2](features/tools.md)

## 账号、Profile 与安全

- [登录与多 profile](profile-login.md)
  - [设备信息-profile 绑定](features/device.md)
- [验证码链](captcha.md)
- [权限系统](permissions.md)
- [远程 spawn](remote-spawn.md)

## 签到

- [签到与调度总览](checkin.md)
  - [自动签到-多 profile](features/checkin.md)
  - [签到调度-随机与固定](features/scheduler.md)

## 游戏数据查询

- [个人查询总览](daily-note.md)
  - [体力查询-原神、星铁、绝区零](features/daily-note.md)
  - [面板查询-原神、星铁、绝区零](features/panel-query.md)
  - [战绩查询-原神、绝区零](features/record-query-genshin-zzz.md)
  - [战绩查询-星铁](features/record-query-starrail.md)
  - [抽卡记录-原神、星铁、绝区零](features/gacha-log.md)
  - [队伍伤害-原神](features/team-damage-genshin.md)
  - [队伍伤害-星铁](features/team-damage-starrail.md)
  - [挑战查询-图鉴期数](features/challenge-query.md)

## 图鉴与成就

- [图鉴总览](atlas.md)
  - [图鉴查询-多游戏资料](features/atlas-gallery.md)
  - [成就图鉴-查漏补缺](features/achievements.md)
- [Auto-Plugin 与角色攻略维护](auto-plugin.md)
  - [三游戏攻略-本地缓存与增量刷新](features/strategy-cache.md)

## 媒体、外部任务与群管理

- [B 站解析与下载](bilibili.md)
- [网易云合伙人-自动任务](features/netease-partner.md)
- [群管理-成员导出与退群清理](features/group-manager.md)

## 快速索引

- [指令索引](commands.md)
- [小功能索引](features/README.md)
- [致谢与引用](references.md)

插件默认采用共存模式，不写入其他插件的禁用项。只有显式开启“接管冲突功能”后，才会替代部分登录、验证码、体力、图鉴和 B 站解析入口。

使用中遇到问题，欢迎加入荷花的小群 `702211431` 反馈。

## 当前调度与帮助行为

- 自动签到与手动签到始终可以同时使用，不设置互斥总开关。
- 到期扫描只执行已有计划，不会在计划被清理后擅自重建。
- 计划生成日期由“生成计划时间”和“当日/次日计划分界”共同决定。
- `#荷花帮助` 返回包含完整指令的本地图片卡片，末尾附当前维护仓库的指令文档直链。

## 当前初始化与更新保护

- `#初始化荷花` 仅供 bot 主人使用；源码必须已经放入插件目录并被 Yunzai 成功加载。
- 全部依赖站点不可达时在任何修改前停止；部分站点失败时保留逐阶段反馈。
- 基础关键阶段按顺序执行，首个失败会阻止后续修改，并阻止 Python、工具、背景和图鉴运行时初始化。
- 回滚基线先写入随机临时代次，完整后原子改名；失败不会留下可被误用的半成品代次。
- 更新保护兼容普通仓库、Git worktree 和 `core.hooksPath`；并发 Hook 使用 PID 独立临时日志。
- 外部命令超时会清理进程树；即使首进程先退出，也会强制结束仍在运行的同组子进程。
- 当前 Windows 本地完整回归基线：**97 passed / 0 failed**；攻略缓存与刷新定向测试：**10 passed / 0 failed**。
- 当前媒体发送基线：**LLBot 8.1.8**；已复测旧版出现 `Highway 102902` 的大视频发送链路。

完整原理见[初始化](initialization.md)，人工部署见[安装与部署](installation.md)，维护复核见[运行手册](maintenance-runbook.md)。
- [?????????????](../../map-route-blueprint.md)

- [体力查询失败排查记录](daily-note-troubleshooting.md)
