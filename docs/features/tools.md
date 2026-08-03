# 工具链-BBDown/ffmpeg/aria2

返回：[上一级](../initialization.md) / [文档目录](../README.md) / [小功能索引](README.md)

## 功能特性

- 自动准备 B 站下载所需的 BBDown、ffmpeg、ffprobe、ffplay 和 aria2c。
- Windows 识别 `.exe` 文件；Linux/macOS 识别无后缀可执行文件，并在初始化时补 `chmod +x`。
- 下载到损坏压缩包、不完整 shared 包或 `.part` 临时文件时，会清理后重新下载。
- Linux 缺少 `unzip`/`tar` 时自动回退到 Python 标准库，并检查归档路径穿越及危险 tar 成员。
- B 站下载固定走 BBDown，ffmpeg 和 aria2c 只作为配套工具链。

## 指令用法

```text
#初始化工具环境
```

## 变量说明

此指令没有额外变量。初始化结果会写入运行时缓存目录，正常使用时不需要手动移动工具文件。

## 自动平台识别

初始化器会生成 `平台-CPU-libc` 环境键，例如 `windows-x64`、`linux-x64-glibc`、`linux-arm64-musl` 和 `darwin-arm64`。

工具选择顺序如下：

1. 检查 `data/tools/bin` 中的组件，并实际运行版本命令验证；仅有同名文件不再视为成功。
2. 检查系统 `PATH` 中的 BBDown、ffmpeg/ffprobe、aria2c。
3. 按当前系统与 CPU 严格匹配 GitHub Release 资产。
4. 若配置了环境直链，优先使用最具体的直链键。

`urls` 支持从具体到通用的回退顺序：`平台-CPU-libc`、`平台-CPU`、`平台`、`default`。

```yaml
tools:
  aria2:
    urls:
      linux-x64-glibc: https://mirror.example/aria2-linux-x64-glibc.tar.gz
      windows-x64: https://mirror.example/aria2-win-x64.zip
```

aria2 官方 Release 当前只提供 Windows 预编译包；Linux 的 `.tar.gz/.tar.xz` 是源码包，`aarch64-linux-android` 是 Android 程序。Linux/macOS 会优先使用系统 `aria2c`，没有系统组件或自定义兼容直链时会明确报告缺失，不再下载异构程序。

## TRSS/Linux 推荐组件

在镜像构建阶段安装系统 FFmpeg 与 aria2：

```bash
apt-get update
apt-get install -y --no-install-recommends ffmpeg aria2
```

初始化时会实际运行 `ffmpeg -version`、`ffprobe -version` 和 `aria2c --version`；只有命令返回成功才标记为可用。BBDown 的本地文件也会运行 `--help` 健康检查，单纯存在同名文件不算安装成功。

## 常见结果

完整成功结果应满足：

```text
BBDown: ready 或 installed
ffmpeg: system、ready 或 installed
aria2: system、ready 或 installed
ensureAll.ok: true
```

如果只有 aria2 失败，先执行 `command -v aria2c`。Linux 没有该命令时安装系统包，或者在 `tools.aria2.urls.<环境键>` 中提供可信的兼容二进制归档。
