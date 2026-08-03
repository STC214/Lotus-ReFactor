# 安装与部署

> 首次启动会测试背景接口并下载 10 张图片到 `data/render-backgrounds`；默认每天 00:10 更新。更新失败时保留旧图片并按配置重试，详见 [本地背景池](./features/render-background-pool.md)。

返回：[项目主页](../README.md) / [文档目录](README.md)

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

## 安装

在 Yunzai 根目录安装锅巴与 Lotus：

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
apt-get install -y --no-install-recommends python3 python3-venv ffmpeg aria2 ca-certificates
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
