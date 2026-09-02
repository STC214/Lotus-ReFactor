> 默认使用共存模式，不会禁用其他插件。需要由 Lotus 接管冲突功能时，可在锅巴中显式开启；详见 [兼容与接管模式](docs/compatibility.md)。

# Lotus-Plugin ReFactor

`Lotus-Plugin` 的重构维护分支，目标是把旧插件拆成可维护、可测试、profile-aware 的实现。主页面只保留概览，完整使用说明请看 [文档目录](docs/README.md)。

- 当前维护仓库：[STC214/Lotus-ReFactor](https://github.com/STC214/Lotus-ReFactor)
- 上游来源仓库：[MOPELotus/Lotus-ReFactor](https://github.com/MOPELotus/Lotus-ReFactor)
- 完整[致谢与引用清单](docs/references.md)

本项目为源码可见的专有软件（Source-Available Proprietary Software）。允许个人非商业原样使用；禁止二次修改发布、搬运、商用、售卖及去除署名。完整条款见 [LICENSE](LICENSE)。

## 文档

完整使用说明请从 [文档目录](docs/README.md) 进入。

后续由自动化维护代理接手安装、Docker 部署或历史故障排查时，先阅读[安装与故障处置运行手册](docs/maintenance-runbook.md)。

分容器部署当前验证的媒体发送基线为 **LLBot 8.1.8**（镜像 `linyuchen/llbot:8.1.8`）。旧版 `8.1.0` 曾在较大视频上传时返回 `Highway 102902`；升级、挂载、验收和回滚流程见 [LLBot 部署与大文件发送](docs/llbot.md)。

B站下载当前采用节省磁盘模式：关闭成品缓存，等待 QQ 发送调用结束后删除本地视频或 ZIP，并在启动约60秒后及每天 `04:20` 执行兜底清理。该时间与 `04:10` 的攻略作者库刷新错峰；锅巴中应保持“启用下载缓存=关闭、发送后删除=开启”。完整原理和切换方法见 [B站解析与下载](docs/bilibili.md#下载文件缓存与清理策略)。

Auto-Plugin 与角色攻略的当前共存方案、新角色攻略全量发现、更新与回滚说明见 [Auto-Plugin 与角色攻略维护](docs/auto-plugin.md)。Lotus 自身的三游戏攻略索引会持久化到本地；查询使用12小时新鲜期和内存缓存，过期命中时先返回再后台并行增量检查，详见[三游戏攻略本地缓存与增量刷新](docs/features/strategy-cache.md)。

## 从已有 Yunzai 安装当前完全体

已经把 Lotus 源码放入 `plugins/Lotus-Plugin` 并至少成功加载一次后，bot 主人可直接发送：

```text
#初始化荷花
```

该主人专用指令会先显示 GitHub、Gitee、PyPI、Python Files 和 npm 等依赖站点的 HTTP Ping，并提醒检查“魔法网络”，随后自动执行运行手册中的可回滚基线备份、系统组件检查、锅巴安装、Git/ZIP 两种来源的子组件补齐、pnpm 版本自适应、构建策略持久化、Node 原生依赖修复、Python/验证码/下载工具/背景池/图鉴初始化和测试验收。全部依赖站点不可达时会在修改环境前停止；任一基础关键阶段失败后不再执行后续修改或运行时初始化。基线采用临时代次完整写入后原子切换，Git Hook 使用独立临时日志，超时命令会清理完整进程树。账号扫码登录及设备绑定涉及每个账号各自的登录态，仍在初始化完成后按结果卡提示逐个执行。详细说明见[一键完整初始化](docs/initialization.md#一键完整初始化)。

当前完整回归基线为 **99 passed / 0 failed**，其中攻略增量、12小时新鲜期、后台刷新和并发刷新定向测试为 **10 passed / 0 failed**，B站磁盘策略和清理边界定向测试为 **2 passed / 0 failed**。维护、验证、回滚和更新后复核步骤见[安装与故障处置运行手册](docs/maintenance-runbook.md)。

如果 Yunzai/TRSS-Yunzai 已经可以正常启动，按以下顺序安装即可：

1. 安装系统组件：`python3`、`python3-venv`、`ffmpeg`、`aria2`、`zip`、`unzip`、`ca-certificates`。
2. 在 Yunzai 根目录克隆锅巴和 Lotus；Lotus 必须带 `--recurse-submodules`。
3. 在 Yunzai 根 `pnpm-workspace.yaml` 允许 `skia-canvas` 构建，然后执行根工作区 `pnpm install`。
4. 验证 `skia-canvas`；若缺少 `skia.node`，运行依赖自带的官方 `prebuild.mjs download --or-compile`。
5. 重启 Yunzai，依次发送 `#荷花状态`、`#初始化签到环境`、`#初始化工具环境`、`#全量更新图鉴`。
6. 每个 profile 再执行扫码登录、注册自动签到、开启需要的游戏签到和测试签到。

可直接复制的完整命令、容器写法、验证命令及失败处理见：[从零安装到当前完全体](docs/installation.md#从已有-yunzai-安装到当前完全体)。安装后的机器人指令顺序见：[初始化](docs/initialization.md#完全体初始化顺序)。

## 鸣谢

感谢以下上游项目、依赖项目与社区项目提供的源码基础、思路及技术支持：

- **上游来源**：[MOPELotus/Lotus-ReFactor](https://github.com/MOPELotus/Lotus-ReFactor)

- [MOPELotus/xiaoyao-cvs-plugin](https://github.com/MOPELotus/xiaoyao-cvs-plugin)
- [ctrlcvs/xiaoyao-cvs-plugin](https://github.com/ctrlcvs/xiaoyao-cvs-plugin)
- [Womsxd/MihoyoBBSTools](https://github.com/Womsxd/MihoyoBBSTools)
- [luguoyixiazi/test_nine](https://github.com/luguoyixiazi/test_nine)
- [luguoyixiazi/model_save](https://huggingface.co/luguoyixiazi/model_save)
- [device-plugin](https://gitee.com/liangho-ng/device-plugin)
- [kissnavel/loveMys](https://github.com/kissnavel/loveMys/)
- [ttocr 文档](https://www.ttocr.com/docs)
- [ZZZure/ZZZ-Plugin](https://github.com/ZZZure/ZZZ-Plugin)
- [Nwflower/Atlas](https://github.com/Nwflower/Atlas)
- [MOPELotus/calendar-plugin](https://github.com/MOPELotus/calendar-plugin)
- [MOPELotus/nanoka-atlas-backend](https://github.com/MOPELotus/nanoka-atlas-backend)
- [zolay-poi/achievements-plugin](https://gitee.com/zolay-poi/achievements-plugin)
- [AFanSKyQs/FanSky_Qs](https://github.com/AFanSKyQs/FanSky_Qs)
- [TimeRainStarSky/Yunzai](https://github.com/TimeRainStarSky/Yunzai)
- [yoimiya-kokomi/miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin)
- [guoba-yunzai/guoba-plugin](https://github.com/guoba-yunzai/guoba-plugin)
- [LLOneBot/LuckyLilliaBot](https://github.com/LLOneBot/LuckyLilliaBot)

敏感数据只允许写入 `data/` 或用户本地配置，不要提交 cookie、stoken、mid、打码平台 key、OTP secret 或远程 spawn 输出。

## 交流与反馈

使用中遇到问题，欢迎加入荷花的小群 `702211431` 反馈。


- [地图点位与采集路线功能蓝图](../map-route-blueprint.md)
