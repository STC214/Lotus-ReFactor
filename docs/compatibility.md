# 兼容与命令优先级

返回：[项目主页](../README.md) / [文档目录](README.md) / [重叠命令优先级原则](command-priority-policy.md)

## 默认且固定的行为

Lotus 使用共存模式。凡是与 Yunzai、miao-plugin 或其他插件重叠的用户命令，其他插件先处理，Lotus 始终处于末位兜底。该行为不是可选模式，也不会被旧配置改变。

```yaml
compatibility:
  conflict_takeover: false # 历史兼容字段；即使写 true 也不会接管普通命令
  captcha_priority_takeover: true
```

启动时 Lotus 不会向 `config/config/group.yaml` 新增其他插件禁用项；检测到旧版 Lotus 写入的完整禁用列表特征时，会移除属于旧版 Lotus 的条目，同时保留用户自行维护的条目。

## 验证码处理的独立边界

`captcha_priority_takeover` 仅控制米游社 `mys.req.err` 错误处理链。默认开启时，Lotus 先尝试自动验证码流程；失败后其他验证码 handler 仍可继续兜底。它不改变登录、面板、体力、图鉴、攻略、签到或媒体解析等用户命令的归属。

锅巴路径：`荷花插件 → 兼容模式（重叠命令中荷花固定末位） → 验证码优先路由`。修改验证码选项后重启 Yunzai。

## Profile 查询

- 无 profile 后缀的重叠查询始终交给其他插件优先处理。
- 带 Lotus profile 后缀的查询可由 Lotus 在其他插件未处理时兜底。
- `#荷花...` 等 Lotus 独有命令不受重叠命令规则影响。

## 签到与渲染资源协调

miao-plugin 圣遗物分页渲染与 Lotus 签到使用运行期协调器：当前图片完成后让等待中的签到先执行，签到结束再继续下一页。这是资源调度，不是命令抢占，也不会修改双方命令优先级。

## 升级要求

每次合并上游、升级依赖或新增命令前后，都必须执行[重叠命令优先级原则与升级检查清单](command-priority-policy.md)。任何让 Lotus 在重叠用户命令中先于其他插件响应的变化都应阻止部署。
