# 体力查询失败排查记录（Profile 1 / Profile 4）

## 现象
发送 `#全部体力` 后，汇总图片中的部分或全部条目显示“失败”。日志只显示“正在查询”，容易误判为图片渲染失败。

## 日志定位方法
```bash
docker logs --since 1h --tail 2000 trss-yunzai 2>&1 | grep -n -A8 -B8 "全部体力"
```
重点观察每个 Profile 的 `uid`、`error`、`retcode`，不要只看最后一张图片。

## 本次根因
1. Lotus 调用 `genshin/model/mys/mysApi.js` 时，MysApi 会访问全局 `redis` 缓存。
2. 当前 TRSS 模块环境没有暴露裸名 `redis`，查询抛出 `redis is not defined`，导致所有游戏条目失败。
3. 修复后再次实测，星铁账号已经返回正常数据；原神 Profile 1 另有接口返回 `retcode: 1034`，属于账号设备风控。
4. Profile 4 的原神与绝区零条目此前是“未同步 UID”，不是设备字段缺失。

## 已实施修复
`services/dailyNote/service.js` 在创建 MysApi 前检测 `globalThis.redis`；当运行环境没有可用 Redis 时，注入仅用于本次进程的空缓存适配器（`get` 返回空、`setEx` 返回成功）。正常 Redis 环境不会被覆盖。

## 逐账号处理
### Profile 1：设备风控 1034
```text
#绑定设备1
#刷新cookie1
#全部体力
```
按提示发送设备信息 JSON。若仍是 1034，再执行 `#扫码登录1` 后重试。

### Profile 4：UID 未同步
```text
#更新面板4
```
仍为空时依次执行：
```text
#刷新cookie4
#更新面板4
#全部体力
```
设备信息只在 Profile 4 自身返回设备验证时补充，不因 Profile 1 的 1034 结论而重复绑定。

## 验证清单
- 日志出现 `发送群消息` 或 `发送好友消息` 的图片记录；
- 汇总图中成功条目显示具体体力数值；
- 失败条目显示独立原因（未同步 UID、1034 等）；
- `docker ps` 显示 `trss-yunzai` 为 `healthy`；
- 重启后再次执行 `#全部体力`，确认 Redis 兜底仍生效。
