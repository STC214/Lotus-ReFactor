# 荷花插件安装与故障处置运行手册（维护代理专用）

> 本文是后续维护代理接手本项目时的单一入口。目标不是介绍功能，而是让代理在 **Yunzai 已存在** 的前提下，能够按固定顺序完成安装、验收、排错、Docker 部署、本地同步和回滚。遇到冲突时，以实际代码、`config/global.yaml`、容器日志和本文中的验收条件为准；普通用户说明见[安装与部署](installation.md)和[文档目录](README.md)。

## 1. 接手后先确认的事实

### 1.1 当前维护对象

- 当前维护仓库：`STC214/Lotus-ReFactor`
- 上游来源：`MOPELotus/Lotus-ReFactor`
- 本机源码：`F:\Project\03_Game_Tools\Yunzai_Lotus\Lotus-ReFactor`
- Yunzai 容器名：`trss-yunzai`
- LLBot 容器名：`llbot`
- LLBot 当前验证镜像：`linyuchen/llbot:8.1.8`
- 容器内 Yunzai 根目录：`/root/Yunzai`
- 容器内插件目录：`/root/Yunzai/plugins/Lotus-Plugin`
- 宿主机持久化插件目录：`/mnt/sda4/TRSS-Yunzai/yunzai/plugins/Lotus-Plugin`
- Yunzai Compose：`/mnt/sda4/TRSS-Yunzai/docker/docker-compose.yml`
- LLBot Compose：`/mnt/sda4/LLBot/docker-compose.yml`
- 管理地址：`192.168.13.1`

连接凭据只能从当前会话或密码管理器取得，禁止写入仓库、日志、补丁、截图和文档。

### 1.2 当前容器拓扑

Yunzai 与 LLBot 是两个容器。Yunzai 负责下载和生成文件，LLBot 执行 OneBot 文件上传。因此 LLBot 必须以相同容器路径只读挂载以下目录：

```yaml
services:
  llbot:
    volumes:
      - /mnt/sda4/TRSS-Yunzai/yunzai/plugins/Lotus-Plugin/resources/apk:/root/Yunzai/plugins/Lotus-Plugin/resources/apk:ro
      - /mnt/sda4/TRSS-Yunzai/yunzai/plugins/Lotus-Plugin/data/bilibili/downloads:/root/Yunzai/plugins/Lotus-Plugin/data/bilibili/downloads:ro
```

少任意一个挂载都会出现“Yunzai 内文件存在，但 LLBot 报路径不存在”。修改后必须运行：

```bash
cd /mnt/sda4/LLBot
docker compose config
docker compose up -d --force-recreate llbot
docker inspect -f '{{.State.Status}} {{.State.Health.Status}}' llbot
```

### 1.3 数据边界

- 源码、示例配置和文档可同步。
- `data/`、`config/global.yaml`、profile 配置、Cookie、设备信息、验证码结果和登录态属于运行数据，不得用本地空目录覆盖。
- 替换插件前先备份运行数据；优先原地更新源码，不要无条件删除整个插件目录。
- 固定共存模式：重叠用户命令中 Lotus 永远低于 Yunzai、miao-plugin 和其他插件；旧 `compatibility.conflict_takeover` 值会被忽略。每次合并、升级和部署前必须完成[优先级检查清单](command-priority-policy.md)。

## 2. 从已有 Yunzai 安装完整荷花插件

以下步骤不得调换。每一步只有在验收通过后才进入下一步。

### 2.0 用户侧一键入口

用户已手动把源码放入 `plugins/Lotus-Plugin` 且 Yunzai 已成功加载插件时，可由主人发送 `#初始化荷花`。入口位于 `apps/initializer.js`，实际基础部署脚本为 `scripts/initialize-lotus.mjs`。

脚本严格按本节顺序完成以下工作：依赖站点 HTTP Ping 与“魔法网络”提醒、可执行回滚基线、系统组件、锅巴、Git clone 或 ZIP 来源下的三个子组件及关键文件校验、根工作区构建策略、带状态记录的 Git 更新持久化 Hook、按 Yunzai 声明版本和依赖指纹执行 pnpm 安装、`skia.node` 验证与官方预构建修复、插件测试。命令入口随后调用现有服务完成 Python、MihoyoBBSTools、test_nine/模型、BBDown/ffmpeg/aria2、本地背景和完整图鉴。任一基础关键阶段失败时必须立刻停止后续修改，并跳过 Python、签到工具、背景和图鉴运行时服务；最终结果卡仍需明确显示已执行阶段和失败原因。基础阶段全部成功时，结果卡必须保留全部阶段，不得截断末尾的工具、背景和图鉴结果。该 QQ 指令直接校验 bot 主人身份，不复用可下放的工具安装权限。

维护时注意三个边界：

1. 插件源码不存在或尚未加载时，机器人没有该命令，所以首次 clone 仍由用户完成。
2. Profile 登录态、设备信息和 Cookie 不跨账号复制，初始化结果卡会列出后续逐账号指令。
3. 新装锅巴或修改工作区后不会在结果返回前强制结束当前 Yunzai 进程；结果卡会提示用户执行 `#重启`。

命令与独立脚本使用相同逻辑。无机器人环境可执行：

```bash
cd /root/Yunzai/plugins/Lotus-Plugin
node scripts/initialize-lotus.mjs
```

输出是 JSON Lines，适合保存为部署记录。全部依赖站点均不可达时，脚本在保存基线及任何修改前停止；单个站点失败不阻止其他来源继续。基线使用临时目录完整写入后再原子改名，失败时清除半成品。QQ 进度消息发送失败只记警告，不会中断初始化状态机。QQ 入口与独立脚本共用带 PID、心跳、guard 和所有权 token 的跨进程锁，死亡锁接管不会并行穿透；超时命令会按 Linux/macOS 进程组或 Windows 进程树清理，首进程提前退出时仍会强制清理同组子进程。Windows 的 `.cmd` 通过环境变量传参，继承调用方的 PATH、代理及自定义环境，兼容带空格及 CMD 特殊字符的路径和参数。ZIP 子组件先克隆到临时目录、校验后再原子替换。Hook 和状态文件位置始终通过 Git 查询，普通 `.git` 目录也遵循 `core.hooksPath`，同时兼容 Git worktree 和自定义 Lotus 插件目录；Lotus 管理块位于 shebang 后、用户正文前，正文里的 `exit`/`exec` 不会跳过它。并发 Hook 使用各自 PID 命名的临时日志，再原子替换正式日志；日志每次覆盖，不会无限增长。

只需重新安装或升级持久化 Hook 而不运行完整初始化时执行：

```bash
node scripts/initialize-lotus.mjs --update-persistence-only
```

### 2.1 保存基线

```bash
docker inspect trss-yunzai --format '{{json .Mounts}}'
docker logs --since 10m --timestamps trss-yunzai > /tmp/trss-yunzai-before-lotus.log 2>&1
docker exec trss-yunzai sh -lc 'cd /root/Yunzai && sha256sum pnpm-workspace.yaml'
```

已有插件时额外备份：

```bash
STAMP="$(date +%Y%m%d-%H%M%S)"
cp -a /mnt/sda4/TRSS-Yunzai/yunzai/plugins/Lotus-Plugin \
  "/mnt/sda4/TRSS-Yunzai/yunzai/plugins/Lotus-Plugin.backup-$STAMP"
```

### 2.2 安装系统组件

```bash
docker exec -u root trss-yunzai sh -lc '
  apt-get update &&
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git ca-certificates python3 python3-venv ffmpeg aria2 zip unzip
'
```

验证：

```bash
docker exec trss-yunzai sh -lc '
  git --version &&
  python3 --version &&
  ffmpeg -version | head -n 1 &&
  ffprobe -version | head -n 1 &&
  aria2c --version | head -n 1 &&
  zip -v | head -n 2
'
```

### 2.3 克隆锅巴、荷花及三个子模块

```bash
docker exec trss-yunzai sh -lc '
  cd /root/Yunzai
  test -d plugins/Guoba-Plugin/.git || \
    git clone https://gitee.com/guoba-yunzai/guoba-plugin.git plugins/Guoba-Plugin
  test -d plugins/Lotus-Plugin/.git || \
    git clone --recurse-submodules https://github.com/STC214/Lotus-ReFactor.git plugins/Lotus-Plugin
  cd plugins/Lotus-Plugin
  git submodule sync --recursive
  git submodule update --init --recursive
  git submodule status --recursive
'
```

必须存在并检出的子模块：

```text
MihoyoBBSTools
test_nine
nanoka-atlas-backend
```

`git submodule status` 行首为 `-` 表示未检出，不能继续初始化。

### 2.4 允许 pnpm 构建 skia-canvas

编辑 `/root/Yunzai/pnpm-workspace.yaml`，在现有区段中合并以下内容，不得删除 `sharp`、`puppeteer`、`sqlite3` 等已有项：

```yaml
allowBuilds:
  skia-canvas: true

onlyBuiltDependencies:
  - skia-canvas
```

然后在 Yunzai 根目录安装：

```bash
docker exec trss-yunzai sh -lc '
  cd /root/Yunzai
  pnpm install --ignore-scripts=false
  pnpm rebuild skia-canvas
'
```

验证必须从插件目录执行，否则 pnpm 的依赖链接可能无法解析：

```bash
docker exec trss-yunzai sh -lc '
  cd /root/Yunzai/plugins/Lotus-Plugin
  node -e "for (const n of [\"cheerio\",\"qrcode\",\"skia-canvas\",\"yaml\"]) { require(n); console.log(\"OK\", n) }"
'
```

若缺少 `skia.node`，动态定位实际包目录，不要写死 `.pnpm` 后缀：

```bash
docker exec trss-yunzai sh -lc '
  cd /root/Yunzai/plugins/Lotus-Plugin
  SKIA_DIR="$(node -p '\''require("path").dirname(require("path").dirname(require.resolve("skia-canvas")))'\'')"
  cd "$SKIA_DIR"
  node lib/prebuild.mjs download --or-compile
  test -f lib/skia.node
'
```

#### 更新指令的持久化保护

本环境维护的 TRSS-Yunzai 在 `plugins/other/update.js` 中接入
`lib/update/workspacePolicy.js`。执行 `#更新`、`#全部更新`，包括对应的
强制更新时，更新器会先按原流程拉取代码，然后在任何 `pnpm install` 之前把
以下项目合并回根 `pnpm-workspace.yaml`：

- `allowBuilds.skia-canvas: true`
- `allowBuilds.protobufjs: false`
- `onlyBuiltDependencies` 中包含 `skia-canvas`

合并逻辑只补充上述项目，不删除上游今后新增的构建项。普通插件更新不会触碰
根工作区；荷花插件仍可通过 `#荷花更新` 独立拉取新版本。保护逻辑必须保留在
TRSS-Yunzai 的维护分支中，并让容器的 `origin` 指向该维护仓库，否则主程序
强制更新后下一次进程加载会回到不含保护逻辑的上游文件。

更新后检查：

```bash
docker exec trss-yunzai sh -lc '
  cd /root/Yunzai
  grep -A12 "^allowBuilds:" pnpm-workspace.yaml
  grep -A12 "^onlyBuiltDependencies:" pnpm-workspace.yaml
  test -f lib/update/workspacePolicy.js
'
```

### 2.5 首次启动

```bash
docker restart trss-yunzai
sleep 15
docker inspect -f '{{.State.Status}} {{.State.Health.Status}}' trss-yunzai
docker logs --since 3m --timestamps trss-yunzai 2>&1 | tail -n 300
```

验收标志：

```text
Lotus-Plugin refactor loaded: 29 app(s)
```

随后由主人发送：

```text
#荷花状态
#荷花帮助
```

两者都应返回本地渲染图片；帮助卡每条命令单独一行，末尾是当前维护仓库文档地址。

### 2.6 初始化 Python、签到、验证码、下载工具和图鉴

按顺序发送：

```text
#初始化签到环境
#初始化工具环境
#testnine状态
#全量更新图鉴
#图鉴状态
```

对应容器验收：

```bash
docker exec trss-yunzai sh -lc '
  test -x /root/Yunzai/plugins/Lotus-Plugin/data/python/venv/bin/python
  test -x /root/Yunzai/plugins/Lotus-Plugin/data/tools/bin/BBDown
  ffmpeg -version >/dev/null
  ffprobe -version >/dev/null
  aria2c --version >/dev/null
  echo RUNTIME_OK
'
```

`#初始化签到环境` 负责 Python venv、MihoyoBBSTools、test_nine 依赖和模型；`#初始化工具环境` 单独复核 BBDown、ffmpeg、ffprobe、ffplay、aria2。两条都要执行。

### 2.7 每个 Profile 的必要流程

第一个 Profile 不写数字，之后依次添加后缀：

```text
#扫码登录
#注册自动签到
#启用全部游戏签到
#同步角色
#测试签到

#扫码登录2
#注册自动签到2
#启用全部游戏签到2
#同步角色2
#测试签到2
```

按需补充设备信息：

```text
#绑定设备
#绑定设备2
```

当前没有把全部 Profile 一次完成上述三项登录操作的通用批量命令；不要把一个 Profile 的登录态复制给另一个 Profile。

### 2.8 最终验收

```text
#荷花状态
#荷花帮助
#登录列表
#签到名单列表
#图鉴状态
#testnine状态
#我的签到时间
```

并执行：

```bash
docker exec trss-yunzai sh -lc 'cd /root/Yunzai/plugins/Lotus-Plugin && pnpm test'
```

所有测试必须通过；当前完整基线为 `99 passed / 0 failed`，其中新增的2项B站测试覆盖默认磁盘策略、过期文件删除、缓存清单同步和目录外文件保护。本地未安装 `node_modules` 时先执行 `corepack pnpm install --frozen-lockfile`，不要把因 `yaml` 缺失导致的导入失败记为业务回归失败。

该数字同时在 Windows 本地项目和 TRSS-Yunzai Debian/Linux 容器中复核。与初始化稳定性直接相关的定向用例至少覆盖：全部网络不可达时零修改、关键阶段失败门禁、失败基线无半成品、并发 Hook 独立临时日志、调用方环境继承、超时进程树清理、ZIP 来源安装及回滚脚本可执行性。测试数量变化时，应同步更新项目 README、文档目录、初始化、安装和本运行手册中的基线数字。

## 3. 当前实例关键配置语义

读取实际配置，不凭记忆判断：

```bash
docker exec trss-yunzai sed -n '1,220p' /root/Yunzai/plugins/Lotus-Plugin/config/global.yaml
```

当前实例的重要目标值：

```yaml
render:
  background_pool_size: 30
  background_refresh_cron: "00 10 00 * * ? *"   # 每日 00:10
scheduler:
  plan_generate_cron: "00 30 23 * * ? *"        # 每日 23:30
  plan_date_cutoff_time: "23:00"
  run_due_cron: "0 */5 * * * ? *"
  catch_up_cron: "0 */5 * * * ? *"
  mode: random
  random:
    window_start: "00:20"
    window_end: "01:20"
```

计划日期规则：

- 生成时刻早于分界时间：生成当天计划。
- 生成时刻等于或晚于分界时间：生成次日计划。
- 当前 23:30 晚于 23:00，因此生成次日计划。
- 自动调度和手动签到可以同时使用，不设置互斥总开关。
- 到期扫描只执行已经存在的计划，不负责创建缺失计划。
- 计划补偿从计划生成时刻开始，在半小时内每 5 分钟检查一次；已有计划则跳过。
- 修改计划配置后若要求重建，应先清理目标日期计划，再通过命令重新生成，避免旧计划干扰判断。

锅巴只负责把人类可读的 `HH:MM:SS`、每天/每周/每月和间隔选项转换为后端 7 位 Cron。界面不应要求用户直接填写 Cron；每天、每周、每月必须互斥。

## 4. 已遇问题的诊断与修复矩阵

### 4.1 `Cannot find module '../skia.node'`

**影响：** 扫码图、帮助图、签到图、B站信息图等全部无法渲染。

**判定：**

```bash
docker exec trss-yunzai sh -lc '
  cd /root/Yunzai/plugins/Lotus-Plugin
  node -e "require(\"skia-canvas\"); console.log(\"SKIA_OK\")"
'
```

**修复：** 确认根 `pnpm-workspace.yaml` 的 `allowBuilds` 和 `onlyBuiltDependencies`，执行 `pnpm install`、`pnpm rebuild`；仍失败则运行 2.4 节的 `prebuild.mjs download --or-compile`。修复后重启 Yunzai。

### 4.2 `MihoyoBBSTools runner` 找不到 `result.json`

**影响：** 签到卡显示 `ENOENT ... result.json`。

**真实含义：** Python 子进程未正常生成结果，不是单纯缺少空文件。常见原因是签到环境未初始化、Profile 未登录、设备信息不完整或 Python 依赖失败。

**顺序：**

```text
#初始化签到环境
#扫码登录[profile]
#绑定设备[profile]       （出现验证或设备环境要求时）
#测试签到[profile]
```

同时检查 runner 前后的完整日志，不要通过手工创建 `result.json` 掩盖上游错误。

### 4.3 米游社更新面板要求验证码

验证码通常说明该 Profile 的登录态或设备环境触发风控。先确认当前 UID/Profile，再补设备信息：

```text
#登录列表
#uid
#绑定设备[profile]
```

`#绑定设备4` 只提示安装但没有收到 APK 时，检查 LLBot 的 APK 同路径挂载；见 1.2 节。验证码识别链顺序为 `test_nine -> ttocr -> gtmanual`，本地服务状态用 `#testnine状态` 验证。

### 4.4 `#uid6` 后 `#更新面板` 仍使用旧账号

显式切换必须更新 UID 索引并清除陈旧 Mys 状态。使用以下任一方式核对：

```text
#uid6
#更新面板
#更新面板uid6
```

紧凑形式 `#更新面板uid6` 直接按 `#uid` 列表的一基序号选取账号，适合避免输入完整 UID。若结果仍旧，检查 `services/pluginBridge/uidIndex.js`、`apps/panelUpdate.js` 和同一时间段日志，不要只检查 Profile 默认值。

### 4.5 体力查询报 `genshin/model/mys/MysApi.js` 不存在

Linux 文件名区分大小写，且不同 Yunzai/喵喵版本的目录大小写可能不同。当前 loader 会大小写无关查找 `MysApi`。若仍失败：

```bash
docker exec trss-yunzai find /root/Yunzai/plugins -iname 'MysApi.js' -print
```

确认喵喵/原神数据插件实际安装，不要在荷花目录制造假的 `MysApi.js`。

### 4.6 自动生成计划成功但没有执行随机签到

按完整链路检查，不要只看生成日志：

1. `plan_generate_cron` 是否在目标时间触发。
2. 生成日期是否符合 `plan_date_cutoff_time`。
3. 计划内时间是否处于随机窗口且晚于生成时刻。
4. `run_due_cron` 是否持续扫描。
5. Profile 是否已注册并启用对应游戏。
6. 条目是否处于 `pending/retry`，是否被旧的 `running` 租约卡住。
7. 签到成功后的通知失败不能反向覆盖签到成功状态。

重点日志时间应围绕实际失败日期和计划时间，昨天成功日志只能作为对照，不能代替当天证据。

### 4.7 背景接口慢、图片返回慢或每日更新失败

运行图必须使用本地背景池，而不是每次渲染临时访问网络接口。首次安装会测速并建立本地池；每日 00:10 重新测速和更新。当前行为：

- 保留最新一代清单，文件名变化后 provider 会重新读取 manifest。
- 新一代全部成功后才切换。
- 更新失败时继续保留并使用上一代图片。
- 重试延迟为 10、30、60 分钟。
- 成功切换后删除旧一代，避免目录持续膨胀。

排查 `data/render/backgrounds`、manifest、刷新日志和接口耗时；不要先删除仍在使用的上一代图片。

### 4.8 B站多分P解析失败：`spawn zip ENOENT`

`multi_page_policy: zip` 会在多个分P下载完成后打包。容器应安装 `zip/unzip`：

```bash
docker exec -u root trss-yunzai sh -lc 'apt-get update && apt-get install -y zip unzip'
```

当前代码在 Linux/macOS 找不到 `zip` 时还会回退到 Python `zipfile`。已验证双分P `BV1XXgG6DEKo` 能生成约 11.7 MB ZIP。系统 `zip` 仍是首选。

先区分配置行为和故障：单 P 在 `zip`、`all`、`first` 下都发送视频；多分 P 在 `zip` 下返回压缩包，在 `all` 下逐个发送所有视频，在 `first` 下只发送第一 P 视频。当前默认 `zip` 返回压缩包属于正常行为。策略参与缓存键计算，修改后不会命中旧策略缓存。用户希望普通分享链接优先返回一个视频时，在锅巴选择“只下首 P（first）”，不需要删除缓存或重启。

#### 4.8.1 B站节省磁盘模式

当前部署固定采用“每次重新下载、发送后删除”的组合：

```yaml
bilibili:
  download:
    cache_enable: false
  cleanup:
    enable: true
    startup: true
    cron: "0 20 4 * * ? *"
    delete_after_send: true
    retention_days: 1
    tmp_retention_hours: 6
    max_total_size_mb: 1024
```

不要同时开启 `cache_enable` 和 `delete_after_send`：虽然不会直接报错，但发送后成品及其缓存记录会被删除，缓存不会产生加速效果。配置保存并重启后验证：

```bash
docker exec trss-yunzai sh -lc '
  cd /root/Yunzai/plugins/Lotus-Plugin
  node --input-type=module -e "import { loadGlobalConfig } from \"./core/config/global.js\"; const c=await loadGlobalConfig(); console.log(JSON.stringify({cache_enable:c.bilibili.download.cache_enable,cleanup:c.bilibili.cleanup},null,2))"
'
```

预期 `cache_enable` 为 `false`、`delete_after_send` 为 `true`。插件启动约60秒后和每天 `04:20` 兜底清理，仅扫描 `data/bilibili/tmp`、`downloads` 和 `cache.yaml`。`04:20` 与攻略作者库的 `04:10` 刷新错峰。

### 4.9 B站视频或 ZIP 已生成，但发送时报“路径不存在”

这不是下载失败，而是 LLBot 与 Yunzai 分容器且目录未共享。日志特征：

```text
Yunzai: 发送好友文件 / 发送 video file:///root/Yunzai/...
LLBot: upload_private_file 未知文件类型或路径不存在
```

按 1.2 节添加 B站下载目录同路径挂载并重建 LLBot。验收同一个文件在两边 SHA-256 一致：

```bash
docker exec trss-yunzai sha256sum '/root/Yunzai/plugins/Lotus-Plugin/data/bilibili/downloads/目标文件'
docker exec llbot        sha256sum '/root/Yunzai/plugins/Lotus-Plugin/data/bilibili/downloads/目标文件'
```

### 4.9.1 B站大视频发送失败：`Highway 102902`

锅巴路径：`插件管理 → 荷花插件 → B站解析 → 发送大小限制`。当前部署建议填写 `45`，单位为 MB，对应后端字段：

```yaml
bilibili:
  download:
    video_size_limit_mb: 45
```

这个值不是下载大小上限，而是**视频消息直发与普通文件发送的分界线**：

- 视频文件不大于 45 MB 时，插件优先按 QQ 视频消息发送。
- 视频文件大于 45 MB 时，插件改用群文件或好友文件发送。
- 它不会压缩视频，也不会阻止 BBDown 下载；下载前的大小限制由 `bilibili.download.max_estimated_size_mb` 单独控制。
- 视频消息和群文件底层都可能使用 Highway，因此 `45 MB` 只能改变发送形式，不能作为 Highway 故障修复。

在锅巴修改后点击“保存”。该值写入 `/root/Yunzai/plugins/Lotus-Plugin/config/global.yaml`；当前 `/root/Yunzai` 来自宿主机持久化挂载，所以容器重启后仍然有效。插件更新通常不会覆盖 `config/global.yaml`，但重装或手工覆盖插件目录前仍应备份该文件。

保存后可重启并验证实际加载值：

```bash
docker restart trss-yunzai
docker exec trss-yunzai sh -lc '
  cd /root/Yunzai/plugins/Lotus-Plugin
  node --input-type=module -e "import { loadGlobalConfig } from \"./core/config/global.js\"; console.log((await loadGlobalConfig()).bilibili.download.video_size_limit_mb)"
'
```

预期输出为 `45`。若超过 45 MB 的文件仍按视频消息直发，检查锅巴是否保存成功、是否改到了当前容器实际使用的配置文件，以及插件启动日志是否正常。

当前已验证的真实故障链为：旧版 `linyuchen/llbot:8.1.0` 接收 73.54 MiB 完整视频后，在 `upload_group_file` 的 61 MiB 偏移处返回 `HTTP Upload failed with code 102902`；Yunzai 与 LLBot 内文件大小和 SHA-256 一致，证明解析、下载、文件和挂载均正常。升级至 `linyuchen/llbot:8.1.8` 后，实际重新发送成功。

处理顺序：

1. 对比两个容器内目标文件大小和 SHA-256。
2. 查看 LLBot 镜像版本；低于当前验证基线时先备份 Compose 与 `llbot_config`。
3. 拉取 `linyuchen/llbot:8.1.8`，更新 Compose 并使用 `docker compose up -d --force-recreate llbot` 重建。
4. 验证容器健康、保存会话恢复、QQ 在线注册、反向 WebSocket 连接以及 Yunzai 显示 `LLOneBot v8.1.8 已连接`。
5. 必须用原失败文件复测；不要只用一个小视频宣布问题解决。

完整命令和回滚见 [LLBot 部署、升级与大文件发送](llbot.md)。

### 4.10 `#荷花帮助` 无响应或命令挤在一起

检查插件是否加载、Skia 是否正常、帮助文档解析是否成功。帮助卡应使用本地文档生成，每条命令单独一行，并链接当前维护仓库的 `docs/commands.md`。运行：

```bash
docker exec trss-yunzai sh -lc 'cd /root/Yunzai/plugins/Lotus-Plugin && node --test test/help.test.js'
```

### 4.11 `#登录列表` 无返回或消息明显变慢

按消息时间在 Yunzai 和 LLBot 两侧同时取日志。先区分：事件没有到 Yunzai、插件没有命中、外部网络等待、渲染等待、还是发送适配器失败。背景图必须走本地池；禁止看到“慢”就重新初始化全部环境。

### 4.12 图鉴更新 `atlas update failed: non_zero_exit`

先查看失败时刻前后的完整子进程输出，并确认 `nanoka-atlas-backend` 子模块、Python 环境、网络和磁盘空间：

```bash
docker exec trss-yunzai sh -lc '
  cd /root/Yunzai/plugins/Lotus-Plugin
  git submodule status nanoka-atlas-backend
  df -h
'
```

随后运行 `#全量更新图鉴` 并立即查看日志。快捷路由刷新成功只代表旧数据仍能读取，不代表本次更新成功。

### 4.13 新角色攻略缺失或被其他插件抦截

先同时检查命令路由、攻略源和本地图片数，不要只依据“仓库已是最新”判定数据完整。当前已验证的原因与修复是：

1. Mora 的通用 `#角色攻略` 规则优先级为 `5`，会早于 Genshin 的 `50` 命中；调整为 `5000`后由 Genshin 攻略路由优先处理。
2. Genshin 默认攻略源 `7` 在当前环境无数据；改用已验证可用的源 `1`。
3. Auto-Plugin 旧逻辑只遍历已存在的 JPG，无法为新角色建立文件，且 TRSS 临时目录写成 `/data/strategy`。当前修复从 Yunzai `Character` 模型全量发现官方角色，使用 `/root/Yunzai/temp/strategy`，每个合集只请求一次，并允许创建新 JPG。

当次实测结果为：`11` 张旧图 → `118` 张，扫描 `125` 个官方角色，可用 `118`、下载 `118`、失败 `0`、上游暂无 `7`。完整配置、调度、Git 更新和回滚步骤见 [Auto-Plugin 与角色攻略维护](auto-plugin.md)。

Lotus 自身的三游戏攻略作者库与 Auto-Plugin 的原神 JPG 库相互独立。Lotus 将文章索引持久化在 `plugins/Lotus-Plugin/data/strategy-authors/cache.json`：首次为空时分页建库，定时任务和主人手动更新从最新页开始增量检查，遇到本地已知文章即停止翻页。普通角色查询使用12小时作者新鲜期和进程内存缓存；过期命中先回复再后台刷新，过期未命中才等待刷新。请求失败保留旧缓存。排查时先按[三游戏攻略本地缓存与增量刷新](features/strategy-cache.md)验证 JSON、增量页数和日志，不要把删除缓存作为首选操作。

## 5. 日志检查标准流程

容器日志时间戳通常同时包含 Docker UTC 时间和应用本地时间，报告时必须写明使用哪一种。优先获取原始上下文，不要只 grep 一行错误：

```bash
docker logs --since 2h --timestamps trss-yunzai 2>&1 > /tmp/yunzai.log
docker logs --since 2h --timestamps llbot 2>&1 > /tmp/llbot.log
```

对于文件发送问题，必须同时检查两个容器。对于定时问题，范围至少包含触发点前 10 分钟到计划窗口结束。对于“今天失败”，不得用昨天成功记录得出成功结论。

每次结论应包括：

1. 用户消息到达时间。
2. 命中的插件和函数。
3. 外部进程或接口结果。
4. 生成的文件及大小/哈希。
5. OneBot 发送动作及 LLBot 返回。
6. 最早的根因错误，而不是后续连锁错误。

## 6. 本地源码、容器和仓库同步规则

### 6.1 修改原则

本地源码是要提交的版本，容器是运行验证环境。临时在容器修复后，必须把同一修改同步到本机仓库；最终用 SHA-256 确认一致。不要用容器的 `data/` 覆盖本地源码，也不要用本地空 `data/` 覆盖容器运行数据。

### 6.2 部署前

```powershell
Set-Location F:\Project\03_Game_Tools\Yunzai_Lotus\Lotus-ReFactor
git status --short
git diff --check
node --check services\bilibili\service.js
```

建立时间戳备份并记录原文件 SHA-256。修改源文件、补丁、验证输出和回滚脚本必须是四个可独立使用的角色。

### 6.3 部署后

```bash
docker exec trss-yunzai sh -lc 'cd /root/Yunzai/plugins/Lotus-Plugin && pnpm test'
docker restart trss-yunzai
docker inspect -f '{{.State.Status}} {{.State.Health.Status}}' trss-yunzai
docker logs --since 3m trss-yunzai 2>&1 | tail -n 300
```

对每个修改文件分别比较本地与容器 SHA-256。只有测试通过、容器健康、插件重新加载、原失败路径复测成功，才算完成。

### 6.4 Git 注意事项

- `LF will be replaced by CRLF` 是行尾提示，不等于内容错误；用 `git diff --cached` 检查实际改动。
- `plugins/Guoba-Plugin` 若被父仓库忽略，`git add -f` 只影响本次纳入；之后已被跟踪的文件正常提交，但不建议长期把完整第三方插件塞进 Yunzai 主仓库。
- 提交前检查是否意外纳入 Cookie、设备数据、日志、模型、下载视频、背景池或备份目录。

## 7. 回滚

### 7.1 插件源码

恢复修改前备份，保留 `data/` 和本地配置，重新执行根工作区安装并重启：

```bash
docker exec trss-yunzai sh -lc '
  cd /root/Yunzai
  pnpm install --ignore-scripts=false
'
docker restart trss-yunzai
```

### 7.2 LLBot 文件挂载

当前 Compose 基线备份：

```text
/mnt/sda4/LLBot/docker-compose.yml.bak-20260813-llbot-lotus-downloads
```

当前回滚脚本：

```bash
/mnt/sda4/LLBot/rollback-lotus-download-mount.sh --execute
```

当前 LLBot 版本升级验证备份：

```text
/mnt/sda4/LLBot/backups/upgrade-8.1.0-to-8.1.8-20260824-154154
```

该代次包含升级前 Compose、完整 `llbot_config`、修改后 Compose、补丁、验证记录和已实测的 `rollback.sh`。一般化升级与回滚步骤见 [LLBot 专题](llbot.md)。

### 7.3 Yunzai 根工作区

`pnpm-workspace.yaml` 修改前应有单独备份。恢复时只恢复该文件，再执行 `pnpm install`；不要删除整个 `node_modules` 作为第一反应。

## 8. 完成判据

只有同时满足以下条件才报告“完全体安装完成”：

- 三个子模块已检出。
- Node 四项依赖可加载，`skia.node` 存在。
- 主 Python venv、test_nine、模型和 BBDown 可用。
- ffmpeg、ffprobe、aria2、zip 可执行。
- 图鉴全量更新完成。
- 至少一个 Profile 完成扫码、注册、启用游戏和测试签到。
- 自动计划日期正确，到期扫描能执行已有任务。
- 本地背景池可用，失败时能保留上一代。
- 单P视频、多分P ZIP、设备 APK 的跨容器路径均可被 LLBot读取。
- LLBot 使用当前验证基线 `8.1.8`，保存会话、QQ 在线和 OneBot 反向连接正常；大视频复测不再出现原 `Highway 102902`。
- `#荷花状态`、`#荷花帮助`、`#登录列表`、`#签到名单列表` 有正常反馈。
- `pnpm test` 全部通过，容器健康，启动日志无新的 Lotus 致命错误。
- 本地源码与容器修改文件哈希一致，并存在补丁、验证记录和可运行回滚。

满足这些条件后停止继续改动，记录当前提交、配置摘要、验证时间和仍存在的外部服务告警。
