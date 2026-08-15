# 初始化

返回：[项目主页](../README.md) / [文档目录](README.md) / [致谢与引用](references.md)

## 一键完整初始化

### 使用前提

先把本仓库放到 Yunzai 的 `plugins/Lotus-Plugin`，并重启到日志中已经出现 Lotus 加载记录。只有插件成功加载后，机器人才能识别：

```text
#初始化荷花
```

这条指令面向“已经手动放入插件源码，但不想再逐条执行环境安装命令”的用户。它不能代替首次 clone，因为源码不存在时，机器人中也不存在这条指令。

### Q：为什么先做网络检测

完整初始化需要从 GitHub/Gitee 拉取源码，从 PyPI/Python Files 下载 Python 包和模型，并从 GitHub Release/npm 获取工具及 Node 原生模块。普通 ICMP `ping` 常被 CDN 禁止，因此脚本测量的是实际 HTTPS 请求的 **HTTP Ping**，这比 ICMP 更接近后续下载能否成功。

网络报告覆盖：

- GitHub 首页、API、Raw 和 Objects；
- Gitee；
- PyPI 与 Python Files；
- npm Registry。

报告会显示每个站点的毫秒延迟或超时原因，并始终提醒确认已经挂好“魔法网络”。单个测速站点失败只会记录到网络报告；全部依赖站点均失败时，会在保存基线、修改文件和安装依赖前停止。进入部署阶段后，任一关键阶段失败也会立即停止其后的安装、更新和运行时初始化，避免在基线保存失败或前置依赖不完整时继续修改环境。进度消息发送异常只记日志，不会打断实际部署状态机。再次发送命令会依据磁盘现状复查，已经完成的内容不会无条件重建。

### 自动执行顺序及原因

1. **保存基线**：保存原 `pnpm-workspace.yaml`、`pnpm-lock.yaml`、两个 Git Hook、Hook 状态文件、受管目录存在状态以及子仓库的分支、提交号和脏工作树状态，并生成独立的 `rollback.mjs`。基线先写入带随机标识的临时代次，文件、清单和回滚脚本全部成功后才原子切换为正式目录；失败时删除临时代次，避免误用半成品备份。普通仓库和 Git worktree 都通过 Git 实际返回的 Git 目录保存 Hook，不假定 `.git` 一定是目录；插件路径同样根据真实位置计算。回滚只恢复初始化实际可能改变的仓库，不会把已有锅巴切成 detached HEAD，并根据 Yunzai、Lotus 声明和本机可用命令选择 pnpm/corepack 对齐 `node_modules`。离线应急时可加 `--skip-dependencies`。
2. **检查系统组件**：验证 `git`、Python、ffmpeg、ffprobe、aria2、zip 和 unzip。Linux、root、apt 环境缺包时自动安装；其余平台明确列出缺项。
3. **检查锅巴插件**：缺失时克隆锅巴。已经存在的完整目录会直接复用，避免覆盖配置。
4. **同步三个子模块**：Git clone 安装使用 `git submodule update`；检测到子组件有未提交修改时会在更新前停止，保护用户工作树。ZIP 或手动复制安装没有 `.git` 时，会从固定官方地址把缺少组件克隆到同级临时目录，关键文件验证通过后才原子改名为正式目录；网络失败会删除临时目录，下一次可以正常重试。非空但残缺的正式目录会保留现场并明确报错。
5. **合并 pnpm 构建策略**：只补入 `skia-canvas: true`、`protobufjs: false` 和 `onlyBuiltDependencies` 中的 `skia-canvas`，保留 Yunzai 原有 `sharp`、`puppeteer`、`sqlite3` 等项目。块状及 `{}`/`[]` 行内 YAML 都会先安全展开再合并。
6. **安装更新持久化保护**：在 Git 实际 Hook 目录中无损加入 Lotus 管理块，通过 `post-checkout` 和 `post-merge` 在更新后恢复构建许可；Hook 使用真实插件相对路径及 `git rev-parse --absolute-git-dir`，因此插件目录改名和 Git worktree 均可工作。管理块固定插入 shebang 之后、用户 Hook 正文之前，因此用户正文里的 `exit` 或 `exec` 不会绕过恢复逻辑；用户正文内容仍原样保留。即使 `.git` 是普通目录，也会查询并遵循 `core.hooksPath`；日志覆盖写入，状态单独记录，失败时显示警告。
7. **安装 Node 依赖**：优先读取 Yunzai 根 `package.json` 声明的 pnpm 版本，未声明时才读取 Lotus 的版本；Windows 通过 `cmd.exe` 和临时环境变量调用 `.cmd`，继承调用方的 `PATH`、代理和自定义环境变量，并保留命令路径、参数中的空格、`&` 和 `%`；Linux/macOS 直接调用可执行文件。首次或依赖指纹变化时安装并重建 `skia-canvas`，状态未变化时跳过。
8. **修复 skia-canvas**：先实际 `require` 验证；仍缺 `skia.node` 时动态定位当前包目录，执行依赖自带的 `prebuild.mjs download --or-compile`，不写死 pnpm 包目录版本。
9. **基础验收**：加载 `cheerio`、`qrcode`、`skia-canvas`、`yaml` 并运行插件测试。
10. **运行环境**：创建 Python venv，安装 MihoyoBBSTools/test_nine 依赖和模型，准备 BBDown、ffmpeg、ffprobe、ffplay、aria2。
11. **运行数据**：修复本地背景池；图鉴数据缺失时执行首次完整生成，已有数据时只检查版本并按需更新，避免重跑整库。
12. **结果卡**：完整列出基础部署及运行环境的每个阶段，不截断工具链、背景或图鉴结果；最后附账号配置和重启提示。

QQ 指令和独立 CLI 共用同一个磁盘锁，QQ 入口另保留进程内快速提示。锁获取、死亡锁判断和替换由短时 guard 串行化，锁文件带随机所有权 token，释放时只删除自己的锁，避免多个进程同时接管死亡锁。主锁记录 PID 并刷新心跳；活跃进程不会因运行时间长被误删，死亡进程遗留锁可恢复。外部命令超时后，Linux/macOS 终止进程组，Windows 使用 `taskkill /T` 终止进程树；即使进程组首进程先退出，也会立即执行强制清理，避免遗留下载或编译子进程。

### 独立运行脚本

机器人指令调用的就是仓库内脚本；维护人员也可在插件根目录直接运行：

```bash
node scripts/initialize-lotus.mjs
```

脚本按 JSON Lines 输出网络检测、阶段开始、阶段结束和最终结果，退出码 `0` 表示关键阶段通过，退出码 `1` 表示存在关键失败。QQ 入口只有在基础部署全部成功后才调用 Python、签到工具、背景和图鉴等运行时服务；基础部署失败时仍返回完整结果卡，但不会继续运行这些服务。

### 初始化后的账号操作

扫码登录、设备信息和 Cookie 都属于各 Profile 的独立凭据，所以脚本不会把一个账号的登录态复制给其他账号。汇总图返回后，每个账号仍按顺序执行：

```text
#扫码登录[profile]
#注册自动签到[profile]
#启用全部游戏签到[profile]
#同步角色[profile]
#测试签到[profile]
```

首次补装锅巴或改变根工作区后，结果卡会提示执行 `#重启`；重启完成后再进入锅巴页面和账号配置流程。

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
