# LLBot 部署、升级与大文件发送

返回：[项目主页](../README.md) / [文档目录](README.md) / [B站解析](bilibili.md) / [维护运行手册](maintenance-runbook.md)

## 当前验证基线

- LLBot 镜像：`linyuchen/llbot:8.1.8`
- LLBot Compose：`/mnt/sda4/LLBot/docker-compose.yml`
- 持久化数据：`/mnt/sda4/LLBot/llbot_config:/app/llbot/data:rw`
- OneBot：LLBot 反向 WebSocket 连接 TRSS-Yunzai
- B站下载目录和设备 APK 目录：以相同绝对路径只读挂载到 LLBot

当前部署曾在 `8.1.0` 上复现大文件 Highway 上传失败：73.54 MiB 视频已经由 BBDown 完整下载，Yunzai 与 LLBot 读取到的大小和 SHA-256 一致，但 `upload_group_file` 在 61 MiB 偏移处返回 `HTTP Upload failed with code 102902`。升级到 `8.1.8` 后，重新发送同一类视频已成功。

这说明该故障位于 LLBot/QQ Highway 上传链，而不是B站解析、BBDown、文件损坏或跨容器路径。本项目因此把 `8.1.8` 作为当前 LLBot 部署基线。

## Compose 配置

```yaml
services:
  llbot:
    image: linyuchen/llbot:8.1.8
    container_name: llbot
    restart: unless-stopped
    environment:
      TZ: Asia/Shanghai
      WEBUI_PORT: "3080"
      AUTO_LOGIN_QQ: "你的机器人账号"
    volumes:
      - /宿主机/LLBot/llbot_config:/app/llbot/data:rw
      - /宿主机/TRSS-Yunzai/yunzai/plugins/Lotus-Plugin/resources/apk:/root/Yunzai/plugins/Lotus-Plugin/resources/apk:ro
      - /宿主机/TRSS-Yunzai/yunzai/plugins/Lotus-Plugin/data/bilibili/downloads:/root/Yunzai/plugins/Lotus-Plugin/data/bilibili/downloads:ro
```

账号、Token 和登录会话只能保存在本机持久化目录，不得写入仓库或文档。

## 从旧版升级到 8.1.8

先确认磁盘空间并备份 Compose 和完整持久化数据：

```bash
cd /mnt/sda4/LLBot
stamp="$(date +%Y%m%d-%H%M%S)"
backup="/mnt/sda4/LLBot/backups/upgrade-llbot-$stamp"
mkdir -p "$backup"
cp -a docker-compose.yml "$backup/docker-compose.yml"
tar -czf "$backup/llbot_config.tar.gz" llbot_config
tar -tzf "$backup/llbot_config.tar.gz" >/dev/null
sha256sum "$backup/docker-compose.yml" "$backup/llbot_config.tar.gz" > "$backup/SHA256SUMS"
```

确认目标镜像存在，修改 Compose 后重建：

```bash
docker pull linyuchen/llbot:8.1.8
sed -i 's#linyuchen/llbot:[^[:space:]]*#linyuchen/llbot:8.1.8#' docker-compose.yml
docker compose config
docker compose up -d --force-recreate llbot
```

不要只执行 `docker restart`：它会继续使用原容器和原镜像配置，不能完成版本切换。

## 升级验收

```bash
docker inspect -f '{{.Config.Image}} {{.State.Status}} {{.State.Health.Status}} {{.RestartCount}}' llbot
docker logs --since 5m llbot 2>&1 | tail -n 200
docker logs --since 5m trss-yunzai 2>&1 | grep -F 'LLOneBot v8.1.8'
docker exec llbot sh -lc 'test -r "/app/llbot/data/config_${AUTO_LOGIN_QQ}.json"'
docker exec llbot test -r /root/Yunzai/plugins/Lotus-Plugin/data/bilibili/downloads
```

必须同时看到：

1. 镜像为 `linyuchen/llbot:8.1.8`。
2. 容器为 `running / healthy`，没有持续重启。
3. 保存的 QQ session 被恢复，日志出现 `Online registered`。
4. 日志出现反向 WebSocket 已连接。
5. TRSS-Yunzai 显示 `LLOneBot v8.1.8 已连接`。
6. APK 与B站下载目录在 LLBot 内可读。
7. 重新发送原失败的大视频成功，LLBot 日志不再出现 `Highway 102902`。

## `video_size_limit_mb` 的真实含义

当前运行值为 `45`：

```yaml
bilibili:
  download:
    video_size_limit_mb: 45
```

- 不大于 45 MB：优先按 QQ 视频消息发送。
- 大于 45 MB：改用群文件或好友文件发送。
- 该值不是下载大小限制，也不会压缩视频。
- 视频消息和群文件底层都可能使用 Highway，因此该选项不能代替 LLBot 升级，也不保证绕过 Highway 故障。
- 下载前预估限制由 `bilibili.download.max_estimated_size_mb` 单独控制。

## `Highway 102902` 排查顺序

1. 确认 BBDown 是否已经生成完整文件。
2. 对比 Yunzai 与 LLBot 内同一文件的大小和 SHA-256。
3. 从日志确认发送动作是 `video` 还是 `upload_group_file`。
4. 查找 LLBot 最早出现的 `Highway` 错误、失败偏移和错误码。
5. 确认 LLBot 至少为当前验证基线 `8.1.8`。
6. 升级后用同一个失败文件复测，避免换样本造成误判。

跨容器文件一致性检查：

```bash
docker exec trss-yunzai sha256sum '/root/Yunzai/plugins/Lotus-Plugin/data/bilibili/downloads/目标文件'
docker exec llbot        sha256sum '/root/Yunzai/plugins/Lotus-Plugin/data/bilibili/downloads/目标文件'
```

若文件一致、LLBot 已是 `8.1.8`，但仍稳定在相同偏移失败，再对同一文件进行一次代理网络与完全直连的 A/B 测试。不要先重新安装荷花、删除下载缓存或重新初始化签到环境。

## 回滚

```bash
cd /mnt/sda4/LLBot
docker compose stop llbot
mv llbot_config "llbot_config.failed-$(date +%Y%m%d-%H%M%S)"
tar -xzf /备份目录/llbot_config.tar.gz
cp -f /备份目录/docker-compose.yml docker-compose.yml
docker compose up -d --force-recreate llbot
docker inspect -f '{{.Config.Image}} {{.State.Status}} {{.State.Health.Status}}' llbot
```

回滚必须同时恢复旧 Compose 和与之配套的持久化数据备份，随后确认账号在线和 OneBot 重新连接。
