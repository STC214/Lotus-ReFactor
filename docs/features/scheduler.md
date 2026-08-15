# 签到调度：固定时间与随机计划

返回：[上一级](../checkin.md) / [文档目录](../README.md) / [小功能索引](README.md) / [致谢与引用](../references.md)

## 完整执行链路

1. `#注册自动签到[profile]` 将对应 profile 标记为启用；未启用的 profile 不进入计划。
2. 每天由 `plan_generate_cron` 触发计划生成；触发时间早于 `plan_date_cutoff_time` 时生成当天计划，等于或晚于分界时生成次日计划。`catch_up_cron` 留空表示关闭补偿，配置后才会检查并补建。
3. 固定模式使用全局 `fixed_time`；profile 可设置自己的固定时间。随机模式会在配置窗口内均匀分配。
4. `run_due_cron` 只扫描并执行当天已有计划；计划不存在时返回 `plan_not_found`，不会擅自创建。计划只能由自动生成任务或 `#生成签到计划` 创建。
5. 自动执行与手动签到入口始终并存、互不禁用。到期条目先持久化 `runningAt`，再刷新登录态、执行 MihoyoBBSTools、处理验证码、渲染并发送结果。
6. 执行结果和重试时间以原子替换方式写回 `data/schedules/YYYY-MM-DD.json`；审计写入 `data/audit/checkin.jsonl`。

## 失败恢复

- 单个 profile 串行执行，失败不会阻断其他 profile。
- runner 超过 `entry_timeout_minutes` 会终止子进程，并按失败重试策略处理。
- 进程异常退出后遗留的 `runningAt`，超过 `running_timeout_minutes` 会自动回收，防止条目永久卡住。
- `failure_retry_minutes` 默认是 `15, 60`：可重试失败会在当天依次延迟 15 分钟、60 分钟再执行；跨越当天的重试不会写入无后续扫描的旧计划。
- 图片渲染失败不会覆盖真实签到结果；改用文本发送。
- 结果消息发送失败不会重新签到，会单独按相同退避序列补发文本通知。
- 计划预告按条目隔离失败；补偿任务会继续处理未通知条目。
- 计划文件采用临时文件加原子替换，降低异常中断造成 JSON 截断的风险。

## 配置

```yaml
scheduler:
  plan_generate_cron: "0 0 0 * * ? *"
  plan_date_cutoff_time: "13:00"
  run_due_cron: "0 * * * * ? *"
  catch_up_cron: "0 */10 * * * ? *"
  mode: fixed
  fixed_time: "04:30"
  entry_timeout_minutes: 20
  running_timeout_minutes: 30
  failure_retry_minutes: [15, 60]
  random:
    window_start: "00:00"
    window_end: "23:30"
    notify_before: true
```

`plan_date_cutoff_time` 是锅巴中的“当日/次日计划分界”，默认 `13:00`。生成时间早于分界时生成当天计划，等于或晚于分界时生成次日计划。不存在“启用自动调度”总开关。

`running_timeout_minutes` 必须大于 `entry_timeout_minutes`。时间必须是合法的 `HH:mm`，例如 `04:30`；`24:00`、`99:99` 会被配置校验拒绝。以上字段也可在锅巴设置页修改。

## 指令

```text
#生成签到计划
#我的签到时间
#执行到期签到
#全部补签
#签到随机模式
#签到固定模式 <时间>
#签到计划生成 <时间>
#签到名单列表
#自动签到日志
#批量刷新签到

#随机签到时间[profile]
#固定签到时间[profile] <时间>
#跟随全局签到时间[profile]
```

- `profile`：可选，范围 `1..255`，省略时使用 profile 1。
- `时间`：必填，使用 `HH:mm`。
- `#执行到期签到`：只处理今日计划中已经到期且尚未完成的条目。
- `#全部补签`：主人对所有已启用的 Profile 立即执行一次签到，不受原计划时间和 `done` 状态限制。结果写回今日计划，适合网络恢复后补做已经失败的任务；只返回一张汇总卡，避免逐账号刷屏。成功条目标记完成；`refresh`、runner、超时等可重试失败会从补签时刻重新按 `failure_retry_minutes` 安排自动重试，不会被错误标记为完成。

## 运维检查

1. 检查配置：锅巴设置页或 `config/global.yaml`。
2. 检查目标日期计划：`#生成签到计划`、`#我的签到时间`；页面会明确显示实际日期。
3. 检查到期执行：主人执行 `#执行到期签到`。
4. 全量补签：网络恢复后主人可执行 `#全部补签`，它会覆盖检查全部已启用 Profile，并将结果同步到今日计划。
5. 检查审计：`#自动签到日志` 或 `data/audit/checkin.jsonl`；定时执行的 `source` 为 `scheduled`，全部补签为 `catch_up_all`。
6. 检查计划状态：`done` 表示结束，`nextRetryAt` 表示签到重试，`notificationRetryAt` 表示仅补发结果通知。
