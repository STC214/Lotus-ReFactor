# 2026-10-05 上游合并与定制保护

- 原生产提交：`26756fb12add6261e40ab56ca18dbe54d6bb7e2b`。
- 合入上游：`3b396c25eee842167f22d66365771a18aa7803d5`。
- 使用 merge 保留既有提交历史，不强制同步或丢弃 fork 的改动。

## 保护与兼容决定

保留末位优先级、无后缀个人查询让行、miao 当前 UID/UID 序号选择、星铁抽卡数据隔离与国际服凭据、完整批量转发、签到优先门控、计划任务、攻略缓存与原图 URL、图形帮助、背景池及可配置渲染倍率。

新来源卡片渲染器保留 CPU 编码分支，软路由无物理 GPU 时仍可出图。已有卡片配置了自定义/轮换背景时继续使用 fork 渲染布局；新模板及无自定义背景调用使用上游来源布局。`help` 保留图形帮助。此选择不改变攻略模块直接使用米游社原图的路径。

媒体任务置于既有 LLBot 挂载内：B站 `data/bilibili/downloads/tasks/bilibili/`，抖音 `data/bilibili/downloads/tasks/douyin/`。发送结束后清理独立任务；旧启动/04:20 清理继续整理历史文件，跳过整个 `downloads/tasks/`。保留旧清理字段，迁移不丢弃管理员配置。新任务不使用历史下载缓存。

Unix 优先通过 Python 打包，正确设置中文 ZIP 文件名的 UTF-8 标志；BusyBox zip 仅作为纯 ASCII 文件名的回退。ZIP 测试使用标准库检查目录与 CRC。合并后的 `sharp` 使用 `^0.35.5`，修复上游带入的依赖告警，pnpm 锁文件同步更新。

生产启动审查发现上游通知逻辑会把缺失的管理员配置转成字符串 `undefined`；已过滤空值和非数字账号并去重，新增回归测试。重启时框架自身的自动 pnpm 安装将 `compression` 从 1.8.1 升至 1.8.2，旧框架补丁造成语法错误；部署环境的 `pnpm-workspace.yaml` 增加 `overrides.compression: 1.8.1`，保留其原有补丁及构建白名单。此环境修复独立保存于维护记录，不混入插件依赖。

## 验证入口

```sh
node --run check
node --test test/*.test.js tests/*.test.js
```

新增 `test/upstream-compatibility.test.js` 验证 CPU 图片、来源卡片、图形帮助、背景兼容、共享挂载路径、活动媒体任务保护和清理函数绑定。完整记录、原始 Git bundles、合并差异及回滚脚本位于维护机 `F:/Project/03_Game_Tools/Yunzai_Lotus_artifacts/upstream-20261005/`。Windows 特有跳过的 Linux 进程测试须在生产部署前于容器环境复跑。自动测试不代替真实米游社账号、QQ 收图和各外部平台的端到端实测。
