# B 站解析与下载

返回：[项目主页](../README.md) / [文档目录](README.md) / [致谢与引用](references.md)

## 功能特性

- 支持 B站长链接、短链接、BV 号、av 号和 QQ 分享卡片。
- 视频解析会输出图片卡片，并继续走 BBDown 下载后发送视频文件。
- 直播只发送信息卡和独立播放器链接，不做直播下载。
- 当前采用节省磁盘模式：不复用已下载成品，发送调用结束后立即删除，并在启动后和每天 `04:10` 兜底清理。
- 标题包含特殊符号时，会优先读取 BBDown 产物和可播放媒体文件，不依赖原始标题精确匹配。

## 指令用法

```text
<B站链接或编号>
#荷花搜视频 <关键词>
#看<序号>
#荷花看视频 <BV号>
#B站下载 <BV号或链接>
#荷花下载 <BV号或链接>
#B站登录
#BBDown登录
#初始化工具环境
```

## 变量说明

- `B站链接或编号`：必填，支持长链、短链、BV 号、av 号和 QQ 分享卡片。
- `关键词`：必填，视频搜索关键词。
- `序号`：必填，搜索结果序号。
- `BV号或链接`：必填，要播放或下载的视频编号或链接。

## 补充说明

解析卡片包含封面、主标题、简介、UP主、视频时长和互动数据。

### 分 P 处理方式

锅巴设置页的“分 P 处理方式”对应后端配置：

```yaml
bilibili:
  download:
    multi_page_policy: zip
```

它只决定一个投稿包含多个分 P 时如何下载和发送；普通单 P 投稿在三种策略下都会直接作为视频发送。

| 锅巴选项 | 配置值 | 多分 P 时的行为 | 适用场景 |
| --- | --- | --- | --- |
| 打包发送 | `zip` | 下载全部分 P，合并成一个 ZIP 文件发送 | 希望一次保存完整合集，接受收到压缩包 |
| 全部下载 | `all` | 下载全部分 P，并把每一 P 分别作为视频依次发送 | 希望直接观看所有分 P，不希望解压 |
| 只下首 P | `first` | 只下载并发送第一个分 P | 希望分享链接时始终优先得到一个视频，减少时间、流量和存储占用 |

当前默认值是 `zip`。因此，多分 P 的B站链接返回压缩包是预期行为，不表示视频格式识别错误。例如 `BV1XXgG6DEKo` 包含两个分 P，在 `zip` 策略下会返回包含两段视频的 ZIP；切换为 `first` 后只返回第一 P 视频，切换为 `all` 后依次返回两个视频。

修改策略后直接保存即可。当前节省磁盘模式关闭下载缓存，因此修改后下一次解析必然按新策略重新下载。若管理员改用缓存模式，缓存键包含 BV号、清晰度和分 P 策略，从 `zip` 切换到 `first` 或 `all` 后也不会继续命中原来的 ZIP 缓存。

B 站下载只走 BBDown。ffmpeg 和 aria2 作为工具链自动准备；ffmpeg 会安装完整构建，包含 `ffmpeg`、`ffplay`、`ffprobe` 和随包文件。多分P选择“打包发送（zip）”时优先调用系统 `zip`；Linux/macOS 若缺少 `zip`，会自动使用 `python3`/`python` 标准库回退打包。建议容器仍预装 `zip`、`unzip`。

### 下载文件缓存与清理策略

当前部署目标是节省磁盘并让每次请求重新获取视频，锅巴应设置为：

```yaml
bilibili:
  download:
    cache_enable: false
    cache_ttl_seconds: 0
  cleanup:
    enable: true
    startup: true
    cron: "0 10 4 * * ? *"
    delete_after_send: true
    retention_days: 1
    tmp_retention_hours: 6
    max_total_size_mb: 1024
```

执行链路为：BBDown 先写入 `data/bilibili/tmp`，完整成品再移动到 `data/bilibili/downloads`；插件等待 `e.reply()`、群文件或好友文件发送调用结束，然后删除本次成品。插件启动60秒后以及每天 `04:10` 还会扫描一次，只处理 `data/bilibili/`：清除超过6小时的临时任务、超过1天的成品，并在总量超过1024MB时从最旧文件开始删除。

“启用下载缓存”和“发送后删除”代表两种不同策略，不应同时开启。两者同时开启通常不会报错，但成品发送后马上被删除，缓存记录也会同步移除，下一次仍需重新下载。需要复用成品时，应改为 `cache_enable: true`、`delete_after_send: false`，并保留天数和容量上限作为兜底。

清理代码会校验目标路径，只删除下载目录内部文件，不会接触签到、Profile、背景图库、攻略缓存、Python环境或其他插件目录。发送阶段使用 `await` 等待适配器调用返回后才删除；LLBot 与 Yunzai 分容器时仍必须保留后文所述的同路径只读挂载。

如果 LLBot 与 Yunzai 分别运行在两个容器中，还必须将 `data/bilibili/downloads` 以相同的绝对路径只读挂载到 LLBot。否则 BBDown 和 ZIP 即使已经成功，LLBot 在发送视频或压缩包时仍会报告“路径不存在”。完整 Compose 示例见[安装与升级](installation.md#llbot-与-yunzai-分容器时发送设备-apk-和-b站文件)。

### 视频发送大小与 LLBot 版本

锅巴“发送大小限制”对应 `bilibili.download.video_size_limit_mb`，当前建议保持 `45 MB`：不大于该值的视频优先按 QQ 视频消息发送，大于该值的文件改用群文件或好友文件发送。这个值只决定发送形式，不限制下载，也不会压缩视频；两种发送形式底层都可能使用 Highway。

当前验证基线为 `linyuchen/llbot:8.1.8`。旧版 `8.1.0` 曾对已经完整下载的 73.54 MiB 视频在 `upload_group_file` 阶段返回：

```text
[Highway] httpUpload Error uploading block at offset 63963136:
HTTP Upload failed with code 102902
```

升级到 `8.1.8` 后，同类大视频重新发送成功。因此遇到信息卡正常、文件已生成但用户没有收到视频时，应先检查 LLBot 版本和发送日志，不要把它误判为B站解析或 BBDown 下载失败。完整升级、验收、排查和回滚见 [LLBot 部署、升级与大文件发送](llbot.md)。

下载会先进入独立临时目录，完成后再按 BBDown 输出和清洗后的标题选择最终文件。标题中带特殊符号时不会用原始标题做唯一精确匹配，会优先读取 BBDown 产物和可播放媒体文件，避免下载成功但找不到成品。

如果工具压缩包下载损坏、解压后缺少可执行文件，或旧目录里残留了不完整的 shared 包，插件会删除损坏目录并重新下载，用户不需要手动进入 `data/tools` 清理。

如果所在网络 IPv6 不可用但 aria2 默认尝试 IPv6，可以在 `bilibili.download.extra_args` 里给 BBDown/aria2 追加强制 IPv4 相关参数，或临时关闭 `bilibili.download.use_aria2` 后重试。

直播只发送信息卡和独立播放器链接，不做直播下载。
