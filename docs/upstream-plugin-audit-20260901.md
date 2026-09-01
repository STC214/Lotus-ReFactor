# Atlas 与 logier-plugin 上游更新审计（2026-09-01）

## 处理目标

在不覆盖容器内本地地图数据、插件配置和运行时文件的前提下，检查 Atlas 与 logier-plugin 是否可以安全更新到各自远程仓库的最新提交。

## 执行流程

1. 记录两个插件的当前提交、远程地址和工作区状态。
2. 使用带日期的临时 stash 保存本地未跟踪配置和数据。
3. 执行 `git fetch origin`，再使用 `git merge --ff-only origin/<当前分支>`。
4. 执行 `git stash pop` 恢复本地文件。
5. 检查提交哈希、工作区、语法和 Yunzai 容器日志。
6. 清理临时 stash 和合并检查日志。

## 审计结果

### Atlas

- 远程：`https://github.com/Nwflower/atlas.git`
- 分支：`master`
- 当前提交：`016e49357666e0823791abdf28fbb3b2efe68225`
- 远程提交：相同
- 结论：已经是上游最新版本，无需合并代码。

本地数据目录保持不变：

- `Genshin-Atlas/`
- `Rocom-Atlas/`
- `star-rail-atlas/`
- `zzz-atlas/`

### logier-plugin

- 远程：`https://gitee.com/logier/logier-plugins.git`
- 分支：`master`
- 当前提交：`c4be7b23754334b804579e019b4f9926588e6ba7`
- 远程提交：相同
- 结论：已经是上游最新版本，无需合并代码。

本地配置文件保持不变：

- `config/API.yaml`
- `config/Config.yaml`
- `config/CustomApi.yaml`
- `config/EmojiHub.yaml`
- `config/GPTconfig.yaml`
- `config/Push.yaml`
- `config/Weather.yaml`

## 验证

- 两个插件 JavaScript 语法检查通过。
- 临时 stash 数量为 0。
- 更新日志显示两个插件均为“已是最新”。
- `trss-yunzai` 容器状态为 `healthy`。
- 未发现插件加载错误或异常崩溃。

## 后续维护

再次更新时仍应先检查工作区；存在本地配置或数据时使用 stash 或备份后再快进更新。不要使用强制覆盖方式更新插件目录。
