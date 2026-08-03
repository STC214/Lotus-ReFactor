# 兼容与接管模式

返回：[项目主页](../README.md) / [文档目录](README.md) / [安装与部署](installation.md)

## 默认行为

Lotus 从配置版本 4 开始默认使用共存模式：

```yaml
compatibility:
  conflict_takeover: false
```

此时插件只加载自己的应用，不会：

- 向 Yunzai `config/config/group.yaml` 写入其他插件禁用项；
- 在运行时追加冲突插件名称；
- 重排其他插件的命令优先级；
- 删除 loveMys 等插件注册的全局验证码 handler。

锅巴路径为：`荷花插件 → 兼容模式 → 接管冲突功能`。修改后重启 Yunzai 才会完整生效。

## 接管模式

需要由 Lotus 统一处理重叠入口时配置：

```yaml
compatibility:
  conflict_takeover: true
```

开启后会恢复以下行为：

1. 将已知冲突入口写入 Yunzai group disable 配置；
2. 在插件重新加载后维护禁用列表和命令顺序；
3. Lotus 的验证码 handler 使用最高优先级，并移除已知旧 handler；
4. 登录、体力、图鉴、成就、B 站等重叠命令优先由 Lotus 响应。

接管模式不会修改其他插件源码，但会影响它们在 Yunzai 中是否获得事件和命令。

## 从旧版本升级

旧版本曾自动写入完整冲突列表。升级后如果保持默认共存模式，启动时会进行一次保守迁移：

- 只有检测到**完整的 Lotus 旧版列表特征**时才移除这些项目；
- 用户自行添加且不属于 Lotus 列表的禁用项会保留；
- 如果只匹配部分项目，因为无法判断所有权，配置保持原样。

迁移前可备份：

```bash
cp config/config/group.yaml config/config/group.yaml.before-lotus-v4
```

## 模式选择

| 场景 | 建议 |
|---|---|
| 已安装多个功能插件，希望各自工作 | 保持 `false` |
| 只使用 Lotus 提供重叠功能 | 设置为 `true` |
| 正在迁移，尚未核对命令归属 | 先保持 `false` |
| 开启后发生命令消失或优先级异常 | 切回 `false` 并重启 |

## 回退

将开关关闭并重启：

```yaml
compatibility:
  conflict_takeover: false
```

若 group 配置只有部分旧条目，插件会保留它们。此时请对照升级前备份手动核对，而不是直接清空整个 `disable` 数组。
