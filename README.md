> 默认使用共存模式，不会禁用其他插件。需要由 Lotus 接管冲突功能时，可在锅巴中显式开启；详见 [兼容与接管模式](docs/compatibility.md)。

# Lotus-Plugin ReFactor

`Lotus-Plugin` 的重构维护分支，目标是把旧插件拆成可维护、可测试、profile-aware 的实现。主页面只保留概览，完整使用说明请看 [文档目录](docs/README.md)。

- 当前维护仓库：[STC214/Lotus-ReFactor](https://github.com/STC214/Lotus-ReFactor)
- 上游来源仓库：[MOPELotus/Lotus-ReFactor](https://github.com/MOPELotus/Lotus-ReFactor)
- 完整[致谢与引用清单](docs/references.md)

本项目为源码可见的专有软件（Source-Available Proprietary Software）。允许个人非商业原样使用；禁止二次修改发布、搬运、商用、售卖及去除署名。完整条款见 [LICENSE](LICENSE)。

## 文档

完整使用说明请从 [文档目录](docs/README.md) 进入。

## 从已有 Yunzai 安装当前完全体

如果 Yunzai/TRSS-Yunzai 已经可以正常启动，按以下顺序安装即可：

1. 安装系统组件：`python3`、`python3-venv`、`ffmpeg`、`aria2`、`ca-certificates`。
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

敏感数据只允许写入 `data/` 或用户本地配置，不要提交 cookie、stoken、mid、打码平台 key、OTP secret 或远程 spawn 输出。

## 交流与反馈

使用中遇到问题，欢迎加入荷花的小群 `702211431` 反馈。
