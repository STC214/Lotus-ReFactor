# 初始化

返回：[项目主页](../README.md) / [文档目录](README.md) / [致谢与引用](references.md)

## 完全体初始化顺序

完成源码与 Node 依赖安装并重启 Yunzai 后，按以下顺序操作：

```text
1. #荷花状态          验证插件与图片渲染
2. #荷花帮助          验证帮助文档和长图生成
3. #初始化签到环境    准备 Python、MihoyoBBSTools、test_nine 和模型
4. #初始化工具环境    独立复核 BBDown、ffmpeg、ffprobe、ffplay、aria2c
5. #testnine状态       验证本地验证码服务
6. #全量更新图鉴      首次生成完整图鉴数据
7. #图鉴状态          验证 items、modules、gallery
8. #扫码登录[profile] 逐个建立账号 profile
9. #注册自动签到[profile]
10. #启用全部游戏签到[profile]
11. #同步角色[profile]
12. #测试签到[profile]
13. #生成签到计划     主人生成并检查计划
14. #我的签到时间     验证该用户的计划条目
```

这个顺序先验证底层渲染，再准备运行环境，最后才建立账号和计划。这样出错时能准确判断是在 Node 原生依赖、Python、外部工具、图鉴数据、登录态还是调度阶段。

`#初始化签到环境` 已经会检查工具链，但仍建议紧接着执行 `#初始化工具环境`：前者用于得到完整签到环境，后者用于输出独立、清晰的下载工具检查结果。

完整的系统命令、clone、pnpm、`skia.node` 修复和验收步骤见：[从已有 Yunzai 安装到当前完全体](installation.md#从已有-yunzai-安装到当前完全体)。

## 基础配置

全局配置样例在 `config/global.example.yaml`。用户 profile 样例在 `config/profile.example.yaml`。

插件加载时如果没有 `config/global.yaml`，会自动按默认配置创建，不需要手动复制样例文件。已安装锅巴插件时，可以在锅巴面板里修改全局配置。

运行时数据会写入：

- `data/users/<qq>.yaml`
- `data/users/<qq>-2.yaml`
- `data/python/`
- `data/tools/`
- `data/atlas/`

这些目录不应提交。

## 签到环境

发送：

```text
#初始化签到环境
```

会检查并准备：

- `data/python/venv`
- `MihoyoBBSTools` 子模块依赖
- `data/python/test_nine_venv`
- `test_nine` 服务依赖
- `data/test_nine/model`
- BBDown、ffmpeg、aria2 工具链

默认使用 venv，不污染系统 Python。高级用户可以在全局配置里切换为 system Python。

在 Debian/TRSS 镜像缺少 `ensurepip` 时，初始化器会自动切换到无 pip venv，再使用官方 `get-pip.py` 补齐 pip。TestNine 模型下载采用远端大小校验、`.part` 临时文件、三次重试和原子替换；截断文件不会被标记为安装完成。

## 下载工具

发送：

```text
#初始化工具环境
```

会按系统和架构准备 BBDown、ffmpeg、aria2。B 站下载只保留 BBDown 路径，不再提供“是否使用 BBDown”的开关。

ffmpeg 会下载完整编译包，而不是只拷贝 `ffmpeg` 一个文件；Windows 会识别 `.exe`，Linux/macOS 会识别无后缀可执行文件。解压后会把 BBDown、ffmpeg、ffprobe、ffplay、aria2c 等可执行文件加入插件工具目录，并在非 Windows 系统上自动补 `chmod +x`。

如果下载目录里存在不完整 shared 包、损坏压缩包或 `.part` 临时文件，初始化会按损坏状态重新下载并修复。

Linux 最小镜像没有 `unzip` 时会自动使用 Python 标准库解压 ZIP；没有 `tar` 时同样可回退到 Python。回退解压会拒绝路径穿越、链接和设备类 tar 成员。Linux 的 aria2 官方 Release 不提供通用预编译包，因此应预装系统 `aria2c` 或配置与当前环境完全匹配的直链。

更多说明见 [工具链-BBDown/ffmpeg/aria2](features/tools.md)。
