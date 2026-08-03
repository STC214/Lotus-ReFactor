# 设备信息-profile 绑定

返回：[上一级](../profile-login.md) / [文档目录](../README.md) / [小功能索引](README.md)

## 功能特性

- 每个 profile 独立保存设备信息，不会和其他 profile 共用或覆盖。
- 米游社社区签到、游戏签到 UA、绝区零更新面板等请求会自动使用对应 profile 的设备字段。
- 支持完整设备 JSON，也支持已有的 `device_id/device_fp`。
- 资料卡和设备信息页只展示脱敏内容。

## 指令用法

```text
#绑定设备[profile]
#绑定设备信息[profile] <设备信息>
#原神绑定设备[profile]
#星铁绑定设备[profile]
#绝区零绑定设备[profile]
#设备信息[profile]
```

## 变量说明

- `profile`：可选，Lotus 内部 profile 序号，范围 `1..255`；省略时使用 profile 1。
- `设备信息`：可选，完整设备 JSON 或包含 `device_id/device_fp` 的文本。省略时按交互提示继续绑定。

## 交互绑定流程

1. 建议私聊机器人发送 `#绑定设备4`，其中 `4` 替换为目标 profile。
2. 机器人发送 `copy_device_info_1.2.apk`；在 Android 设备安装并打开。
3. 在 APK 内获取并复制完整设备 JSON。
4. 回到同一个聊天窗口，把 JSON 作为一条消息直接发送。
5. 使用 `#设备信息4` 确认设备已绑定。

如果只收到安装提示而没有 APK，请查看 Yunzai 日志中的 `upload_private_file`。分容器部署出现“未知文件类型或路径不存在”时，并非插件内文件缺失，而是文件上传发生在 LLBot 容器；需按[安装与部署](../installation.md#llbot-与-yunzai-分容器时发送设备-apk)为 LLBot 增加同路径只读挂载。
