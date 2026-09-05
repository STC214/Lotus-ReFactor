# 验证码链

返回：[项目主页](../README.md) / [文档目录](README.md) / [致谢与引用](references.md)

默认顺序：

1. `test_nine`
2. `ttocr`
3. `gtmanual`

统一接口返回：

```js
{
  ok: true,
  provider: "test_nine",
  token: "",
  costMs: 0
}
```

失败时必须带：

- provider
- reason
- retryable

## provider

`test_nine` 默认访问本地服务：

```text
http://127.0.0.1:9645/pass_uni?gt=...&challenge=...
```

`ttocr` 使用 GT v3，配置 key、接口、itemid 等参数。

`gtmanual` 默认对接：

```text
https://gt.lotusshared.cn/GTest/register?key=114514
```

## 用户反馈

过码耗时可能很长，调用侧需要提示：

- 遇到验证码，正在尝试过码。
- 方案一失败，正在尝试方案二。
- challenge 已被使用，正在重新请求 challenge。
- 全部方案失败，生成手动过码链接。

JS 业务和 Python 签到 runner 使用同一套 provider 链。全局 `mys.req.err` handler 由独立的“验证码优先路由”开关控制；开启时 Lotus 先尝试处理，但始终保留其他插件的 handler 作为后续兜底。该 handler 不改变查询、面板等用户命令的固定末位原则。
