# 自动签到：多 Profile

返回：[上一级](../checkin.md) / [文档目录](../README.md) / [小功能索引](README.md) / [致谢与引用](../references.md)

## 功能链路

- 每个 Lotus profile 独立保存登录态、设备、游戏开关、执行时间和通知目标。
- 注册自动签到后，计划生成任务读取已启用 profile 并持久化计划；到期扫描只执行已有计划。
- 到期时依次执行：加载 profile → 刷新登录态 → Cookie 预检 → 生成 MihoyoBBSTools 配置 → Python runner → 验证码桥接 → 读取结果 → 渲染 → 私聊/群聊通知 → 审计。
- 单个 profile 失败不会影响其他 profile；国际服和云游戏仅在对应凭据已绑定时参与。
- 社区签到需要设备信息；缺少设备时会跳过社区任务并在结果中说明。

## 首次使用

```text
#初始化签到环境
#扫码登录[profile]
#注册自动签到[profile]
#开启所有游戏签到[profile]
```

多个 profile 需要分别建立登录态和签到配置；完成注册后，每日执行由调度器统一批量处理，不需要每天重复上述指令。自动签到和手动签到始终同时可用，手动执行不会关闭或替代自动计划。

## 签到与游戏开关

```text
#注册自动签到[profile]
#注册本群签到[profile]
#测试签到[profile]
#开始签到[profile]
#手动签到[profile]
#补签[profile]

#开启<游戏>签到[profile]
#关闭<游戏>签到[profile]
#开启全部游戏签到[profile]
#关闭全部游戏签到[profile]

#开启社区签到[profile]
#关闭社区签到[profile]
```

## 通知设置

```text
#开启签到通知[profile]
#关闭签到通知[profile]
#绑定通知群[profile]
#设置通知私聊[profile]
#设置通知群聊[profile]
```

结果优先按 profile 通知配置发送。渲染失败会保留真实签到结果并发送文本；消息通道临时失败会只补发通知，不重复执行签到。

## 变量说明

- `profile`：可选，范围 `1..255`，省略时使用 profile 1。
- `游戏`：支持插件已接入的游戏名，例如 `原神`、`星铁`、`绝区零`。

固定时间、重试、超时、计划补偿和状态字段详见[签到调度](scheduler.md)。
