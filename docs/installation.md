# 安装与部署

> 首次启动会测试背景接口并下载 10 张图片到 `data/render-backgrounds`；默认每天 00:10 更新。更新失败时保留旧图片并按配置重试，详见 [本地背景池](./features/render-background-pool.md)。

返回：[项目主页](../README.md) / [文档目录](README.md) / [致谢与引用](references.md)

## 环境

- Node.js 按当前 Yunzai/TRSS 环境要求准备。
- 常规用户建议使用 `pnpm install`。
- 维护者自己的 TRSS fork 可继续使用 Yarn v4；公开仓库默认按 `pnpm` 安装。
- 已验证 Windows x64 和 TRSS-Yunzai Debian/Linux x64；其他架构会按运行环境严格选择组件。

### Python 自动识别

`python.system_python` 留空或设置为 `auto` 时，插件会自动探测 Python：

- Windows：依次尝试 `py -3`、`python`、`python3`。
- Linux/macOS：依次尝试 `python3`、`python`。
- 每个候选都会执行探针，读取真实解释器路径、版本、实现、系统与 CPU 架构。
- 默认要求 Python 3.10 或更高版本；版本不足会继续尝试下一个候选。

```yaml
python:
  mode: venv
  system_python: auto
  minimum_version: "3.10"
```

填写绝对路径时该路径拥有最高优先级；验证失败后仍会继续尝试平台默认候选。解释器版本或架构变化也会进入依赖指纹，触发必要的依赖重检。

Debian 等发行版可能移除 Python 自带的 `ensurepip`。插件会先尝试正常创建 venv；遇到该情况时改用 `--without-pip`，随后依次尝试 `ensurepip` 和 Python Packaging Authority 的 `get-pip.py`。仍建议容器镜像预装 `python3` 与对应的 `python3-venv`。

## 从已有 Yunzai 安装到当前完全体

下面假设 Yunzai 已经安装完成并能启动，Yunzai 根目录为 `/root/Yunzai`。Docker 用户应在 Yunzai 容器内执行这些命令；宿主机先进入容器：

```bash
docker exec -it trss-yunzai bash
```

如果镜像没有 `bash`，使用：

```bash
docker exec -it trss-yunzai sh
```

### 第 1 步：安装系统组件

Debian/Ubuntu/TRSS 容器执行：

```bash
apt-get update
apt-get install -y --no-install-recommends   git ca-certificates python3 python3-venv ffmpeg aria2 zip unzip
```

这些组件分别用于拉取源码、访问 HTTPS、创建签到 Python 环境、处理视频和下载文件。系统组件缺失时，即使插件源码存在，对应功能也会在运行阶段报找不到命令。

确认：

```bash
git --version
python3 --version
ffmpeg -version | head -n 1
aria2c --version | head -n 1
zip -v | head -n 2
```

### 第 2 步：克隆锅巴与荷花插件

```bash
cd /root/Yunzai

test -d plugins/Guoba-Plugin/.git ||   git clone https://gitee.com/guoba-yunzai/guoba-plugin.git plugins/Guoba-Plugin

test -d plugins/Lotus-Plugin/.git ||   git clone --recurse-submodules   https://github.com/STC214/Lotus-ReFactor.git plugins/Lotus-Plugin

cd /root/Yunzai/plugins/Lotus-Plugin
git submodule sync --recursive
git submodule update --init --recursive
```

必须初始化的三个子模块：

```text
MihoyoBBSTools          米游社签到执行器
test_nine               本地验证码识别服务
nanoka-atlas-backend    图鉴数据后端
```

确认：

```bash
git submodule status --recursive
```

每一行开头应是提交哈希；开头为 `-` 表示该子模块尚未检出。

### 第 3 步：允许 skia-canvas 构建

荷花的帮助图、签到结果图、B 站信息图等都依赖 `skia-canvas`。允许构建项必须写入 **Yunzai 根目录** `/root/Yunzai/pnpm-workspace.yaml`，而不是插件自己的 `package.json`。

先备份：

```bash
cd /root/Yunzai
cp pnpm-workspace.yaml pnpm-workspace.yaml.before-lotus
```

在现有 `allowBuilds` 和 `onlyBuiltDependencies` 中分别加入：

```yaml
allowBuilds:
  skia-canvas: true

onlyBuiltDependencies:
  - skia-canvas
```

如果其中一个区段原本不存在，就在文件末尾创建。不要删除 Yunzai 已有的 `sharp`、`puppeteer`、`sqlite3` 等条目。

确认：

```bash
grep -n -A12 -B2 skia-canvas /root/Yunzai/pnpm-workspace.yaml
```

### 第 4 步：安装 Node 依赖

所有命令都从 Yunzai 根目录执行：

```bash
cd /root/Yunzai
pnpm install --ignore-scripts=false
pnpm rebuild skia-canvas
```

验证荷花声明的依赖：

```bash
cd /root/Yunzai/plugins/Lotus-Plugin
node -e "for (const n of ['cheerio','qrcode','skia-canvas','yaml']) { require(n); console.log('OK', n) }"
```

正确输出应包含：

```text
OK cheerio
OK qrcode
OK skia-canvas
OK yaml
```

#### pnpm rebuild 后仍缺少 skia.node

若仍出现 `Cannot find module '../skia.node'`，定位当前 pnpm 实际安装目录并运行 `skia-canvas` 自带的官方预编译下载程序：

```bash
cd /root/Yunzai/plugins/Lotus-Plugin
SKIA_DIR="$(node -p 'require("path").dirname(require("path").dirname(require.resolve("skia-canvas")))')"
cd "$SKIA_DIR"
node lib/prebuild.mjs download --or-compile
```

然后重新验证：

```bash
find "$SKIA_DIR" -name skia.node -print
cd /root/Yunzai/plugins/Lotus-Plugin
node -e "require('skia-canvas'); console.log('skia-canvas OK')"
```

使用动态定位命令是为了兼容 pnpm 生成的版本及 peer 后缀目录，不要把 `.pnpm/skia-canvas@...` 的完整目录名写死。

### 第 5 步：首次重启与加载验证

退出容器后在宿主机执行：

```bash
docker restart trss-yunzai
docker logs --since 2m trss-yunzai 2>&1 | grep -E 'Lotus-Plugin|skia|MODULE_NOT_FOUND'
```

正常加载应看到：

```text
Lotus-Plugin refactor loaded: 29 app(s)
```

机器人端发送：

```text
#荷花状态
#荷花帮助
```

两条命令都能返回图片，表示插件入口、帮助文档和 Skia 渲染链已经打通。

### 第 6 步：初始化签到、验证码与下载工具

由机器人主人依次发送：

```text
#初始化签到环境
#初始化工具环境
#testnine状态
```

`#初始化签到环境` 会准备主 Python venv、MihoyoBBSTools、test_nine 依赖及模型，并同时检查工具链；`#初始化工具环境` 再单独复核 BBDown、ffmpeg、ffprobe、ffplay 和 aria2c。第二条不是重复安装，而是把下载工具作为独立检查点，方便定位问题。

验证容器内路径：

```bash
docker exec trss-yunzai test -x /root/Yunzai/plugins/Lotus-Plugin/data/python/venv/bin/python
docker exec trss-yunzai test -x /root/Yunzai/plugins/Lotus-Plugin/data/tools/bin/BBDown
echo Lotus-runtime-OK
```

### 第 7 步：初始化完整图鉴

机器人主人发送：

```text
#全量更新图鉴
#图鉴状态
```

第一次全量抓取耗时较长。只有图鉴数据和 gallery 同步完成后，角色、武器、材料、挑战轮换及成就相关查询才算完整可用。

### 第 8 步：为每个账号建立 profile

第一个 profile 不写数字，后续使用 `2`、`3`……作为后缀：

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

若账号遇到设备校验，再执行：

```text
#绑定设备
#绑定设备2
```

只为实际存在的 profile 执行对应命令。自动签到计划由全局调度统一生成；手动签到与自动签到可以同时使用。

### 第 9 步：最终验收

机器人端依次检查：

```text
#荷花状态
#荷花帮助
#登录列表
#签到名单列表
#图鉴状态
#testnine状态
#我的签到时间
```

容器端检查依赖和最近错误：

```bash
docker exec -w /root/Yunzai/plugins/Lotus-Plugin trss-yunzai \
  node -e "for (const n of ['cheerio','qrcode','skia-canvas','yaml']) require(n); console.log('Node dependencies OK')"

docker logs --since 10m trss-yunzai 2>&1 | \
  grep -E 'Cannot find module|MODULE_NOT_FOUND|spawn.*ENOENT|未安装|未编译'
```

最后一条没有输出，且机器人端所有状态命令正常返回，即得到当前维护分支的完整运行形态。

### 更新后的必要动作

插件更新可能改变 `package.json` 或原生依赖。更新后建议执行：

```bash
cd /root/Yunzai/plugins/Lotus-Plugin
git submodule update --init --recursive
cd /root/Yunzai
pnpm install --ignore-scripts=false
pnpm rebuild skia-canvas
docker restart trss-yunzai
```

若更新后再次缺少 `skia.node`，重复第 4 步的动态定位与 `prebuild.mjs` 命令。

### 回滚安装改动

恢复 pnpm 配置：

```bash
cd /root/Yunzai
cp pnpm-workspace.yaml.before-lotus pnpm-workspace.yaml
pnpm install
```

移除插件前先备份账号和运行数据：

```bash
cp -a plugins/Lotus-Plugin/config /root/Lotus-config-backup
cp -a plugins/Lotus-Plugin/data /root/Lotus-data-backup
rm -rf plugins/Lotus-Plugin
```

## 安装

在 Yunzai 根目录安装锅巴与 Lotus。下例使用包含本文所述功能的当前维护仓库；上游来源为 [MOPELotus/Lotus-ReFactor](https://github.com/MOPELotus/Lotus-ReFactor)，完整关系见[致谢与引用](references.md)：

```bash
cd /root/Yunzai
git clone https://gitee.com/guoba-yunzai/guoba-plugin.git plugins/Guoba-Plugin
git clone --recurse-submodules https://github.com/STC214/Lotus-ReFactor.git plugins/Lotus-Plugin
pnpm install --filter=guoba-plugin
pnpm install --filter=lotus-plugin
```

pnpm v10 会默认拦截依赖的构建脚本。`skia-canvas` 是图片渲染需要的原生依赖，如果安装时出现：

```text
Ignored build scripts: skia-canvas
```

最简单的修法：进入 Yunzai 根目录，也就是包含 Yunzai 自己 `package.json`、并且安装后生成根 `node_modules` 的目录，执行：

```bash
cd /path/to/Yunzai
pnpm approve-builds
pnpm rebuild skia-canvas
```

`pnpm approve-builds` 会让你选择允许执行构建脚本的包。选中 `skia-canvas`，确认后再执行 `pnpm rebuild skia-canvas`。

如果需要手写配置，不要写到 `plugins/Lotus-Plugin/package.json`。日志出现 `Scope: all ... workspace projects`，说明 pnpm 以 Yunzai 为 workspace 根目录；允许构建配置要写在 Yunzai 根目录的 `pnpm-workspace.yaml`。

pnpm 10：

```yaml
onlyBuiltDependencies:
  - skia-canvas
```

pnpm 11：

```yaml
allowBuilds:
  skia-canvas: true
```

保存后回到 Yunzai 根目录重新执行 `pnpm install` 或 `pnpm rebuild skia-canvas`。

插件首次加载时会自动生成 `config/global.yaml`。如果已经安装锅巴插件，可以直接在锅巴面板里修改荷花插件的全局配置。

如果希望对照上游原始实现，可单独查看：

```text
https://github.com/MOPELotus/Lotus-ReFactor
```

不要在同一个 `plugins/Lotus-Plugin` 工作树里混用两个仓库的文件；切换来源前先备份 `config/` 与 `data/`。

如果 clone 时没有拉子模块：

```bash
git submodule update --init --recursive
```

## 默认共存与可选接管

插件默认配置为：

```yaml
compatibility:
  conflict_takeover: false
```

默认不会写入其他插件禁用项，也不会删除其他验证码 handler，因此可以先和已有插件一起安装、逐项核对命令。需要 Lotus 统一处理冲突入口时，可在锅巴的“兼容模式”中开启“接管冲突功能”，或者修改上述配置为 `true` 后重启 Yunzai。

接管模式可能覆盖以下功能入口：

- 逍遥插件的登录、图鉴、抽卡 authkey 相关入口。
- TRSS-Plugin 的米哈游登录入口。
- loveMys 的全局验证码 handler。
- device-plugin 的全局设备注入逻辑。
- 小花火、rconsole 等插件里的 B站解析入口。

荷花插件不会直接修改这些插件的源码。接管模式会维护 Yunzai/TRSS 的 `config/config/group.yaml` 禁用项、调整处理优先级并替换已知旧验证码 handler。升级时对旧列表采用保守迁移，详细规则见 [兼容与接管模式](compatibility.md)。

## TRSS-Yunzai 容器建议

建议在镜像构建阶段预装 Linux 没有通用预编译 Release 的系统组件：

```bash
apt-get update
apt-get install -y --no-install-recommends python3 python3-venv ffmpeg aria2 zip unzip ca-certificates
```

插件会优先复用通过版本命令健康检查的 `/usr/bin/ffmpeg`、`ffprobe` 和 `aria2c`；BBDown 可由插件按系统和 CPU 自动选择 Release 下载。

### LLBot 与 Yunzai 分容器时发送设备 APK

`#绑定设备[profile]` 会调用 OneBot 的 `upload_private_file` 发送：

```text
/root/Yunzai/plugins/Lotus-Plugin/resources/apk/copy_device_info_1.2.apk
```

当 LLBot 与 Yunzai 位于不同容器时，文件上传动作实际由 LLBot 执行。即使该路径在 Yunzai 容器内存在，LLBot 看不到它仍会返回“未知文件类型或路径不存在”。应把宿主机上的 APK 目录以**相同容器路径**只读挂载给 LLBot：

```yaml
services:
  llbot:
    volumes:
      - /宿主机/TRSS-Yunzai/yunzai/plugins/Lotus-Plugin/resources/apk:/root/Yunzai/plugins/Lotus-Plugin/resources/apk:ro
```

应用并验证：

```bash
docker compose up -d --force-recreate llbot
docker exec llbot ls -l /root/Yunzai/plugins/Lotus-Plugin/resources/apk/copy_device_info_1.2.apk
docker exec llbot sha256sum /root/Yunzai/plugins/Lotus-Plugin/resources/apk/copy_device_info_1.2.apk
docker exec trss-yunzai sha256sum /root/Yunzai/plugins/Lotus-Plugin/resources/apk/copy_device_info_1.2.apk
```

两边文件均存在且 SHA-256 一致后，重新私聊发送 `#绑定设备4`。只读挂载不会允许 LLBot 修改插件资源。
