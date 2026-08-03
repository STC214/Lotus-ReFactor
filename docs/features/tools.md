# 工具链-BBDown/ffmpeg/aria2

返回：[上一级](../initialization.md) / [文档目录](../README.md) / [小功能索引](README.md)

## 功能特性

- 自动准备 B 站下载所需的 BBDown、ffmpeg、ffprobe、ffplay 和 aria2c。
- Windows 识别 `.exe` 文件；Linux/macOS 识别无后缀可执行文件，并在初始化时补 `chmod +x`。
- 下载到损坏压缩包、不完整 shared 包或 `.part` 临时文件时，会清理后重新下载。
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
