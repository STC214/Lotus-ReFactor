# Auto-Plugin 与角色攻略维护

本页记录 2026-08-25 在 TRSS-Yunzai 中安装 Auto-Plugin、排查插件冲突、修复新角色攻略缺失以及将攻略刷新改为每日两次的完整过程。这是当前部署的运维基线，不表示 Lotus 必须依赖 Auto-Plugin。

## 从已有 Yunzai 安装

在 Yunzai 根目录执行：

```bash
cd /root/Yunzai
git clone --depth=1 https://github.com/Nwflower/auto-plugin.git ./plugins/auto-plugin
```

当前 TRSS-Yunzai 根工作区已有 `yaml`、`chokidar`、`lodash`、`node-schedule`、`node-fetch`、`ws` 和 `chalk`，因此本次安装没有额外增加根依赖。其他环境仍应以启动日志和实际 `import` 结果为准，不要盲目复制 `node_modules`。

重启并确认加载：

```bash
docker restart trss-yunzai
docker inspect -f '{{.State.Status}} {{.State.Health.Status}}' trss-yunzai
docker logs --since 3m trss-yunzai 2>&1 | grep -E 'Auto-Plugin|error|Error' | tail -n 100
```

## 冲突检查与开关策略

Auto-Plugin 不只有攻略刷新，默认功能可能会自动更新插件、修改群名、处理群员提醒或执行群管动作。为了与 Lotus、Guoba 和已有群管理逻辑共存，当前方案是：

- 关闭 Auto-Plugin 的自动插件更新和更新提醒。
- 关闭自动改群名。
- 关闭自动禁言、自动处理大量 `@` 等高影响群管功能。
- 只开启已修复并验证的 `autoStrategy`。

规则扫描时仅发现两个通用 `.*` 规则，它们在功能关闭或条件不成立时不会接管 Lotus 正常指令。安装新版 Auto-Plugin 后应重新检查默认配置，因为上游可能新增功能或改变默认值。

## 新角色攻略缺失的原因

仓库都已拉到最新仍查不到新角色，是三个问题叠加，不是单纯的 `git pull` 失败：

1. `mora-plugin` 的 `#角色攻略` 规则优先级为 `5`，比 Genshin 规则的 `50` 更早命中，所以请求被 Mora 先处理。
2. Genshin 的 `defaultSource` 为 `7`，但当前这个源没有可用攻略数据。
3. Auto-Plugin 原来只遍历已经存在的 JPG，所以只会刷新老角色，永远不会给新角色创建第一张图；TRSS 下的临时目录也错写成 `/data/strategy`。

`Nwflower/Atlas` 是图鉴框架与数据来源之一，但检查当前数据仓库后，不应把“更新 Atlas 仓库”当成角色攻略图必然更新的保证。

## 当前修复

### 1. 路由和默认源

- 将 Mora 攻略规则优先级从 `5` 改为 `5000`，避免抦截 Genshin 的角色攻略。
- 将 Genshin `defaultSource` 从空数据源 `7` 改为已验证可用的源 `1`。

### 2. Auto-Plugin 全量发现

`app/autoStrategy.js` 当前执行以下逻辑：

1. 通过 `Character.forEach(..., "official", "gs")` 枚举官方原神角色，而不是枚举现有 JPG。
2. 使用 TRSS-Yunzai 实际可用的 `/root/Yunzai/temp/strategy`。
3. 每个攻略合集只请求一次，在内存中建立角色到资源的索引，避免对每个角色重复请求整个合集。
4. 角色本地图不存在时直接创建，不再只更新旧文件。
5. 只接受配置的攻略源 `1` 至 `4`，并在完成时返回扫描、可用、下载、失败和上游暂无的汇总。

当次全量刷新的字面结果：

```text
BEFORE_FILES=11
RESULT={"group":1,"scanned":125,"available":118,"downloaded":118,"failed":0,"unavailable":7}
AFTER_FILES=118
```

另外对奥黛塔、叶洛亚、尼可和布伦妮的新文件进行了 JPEG 格式校验。`unavailable=7` 表示刷新时上游合集中还没有这些角色的图，不是下载失败。

## 每日两次自动刷新

当前前端启用开关与实际运行配置都是：

```yaml
enable: true
cron: "0 0 4,16 * * ?"
```

这是后端使用的 7 段 Cron，表示**按容器时区在每天 04:00 和 16:00 各触发一次**。当前 `trss-yunzai` 容器时区实测为 `UTC`，所以对应中国标准时间每天 `12:00` 和次日 `00:00`。Auto-Plugin 的更新任务会在触发后再随机延迟 `1` 至 `7,200,000` 毫秒，所以实际执行窗口约为：

- 容器 UTC：04:00–06:00 和 16:00–18:00。
- 中国标准时间：12:00–14:00 和次日 00:00–02:00。

保留随机延迟是为了避免多个机器在整点同时请求上游接口。如果运维人员需要精确在整点完成，还必须同时修改 `UpdateTask` 的延迟逻辑，仅改 Cron 并不会取消这个延迟。

两个配置位置：

```text
/root/Yunzai/plugins/auto-plugin/def/autoStrategy.yaml
/root/Yunzai/plugins/auto-plugin/config/autoStrategy.yaml
```

`def` 是仓库跟踪的默认值，`config` 是当前实例的运行值。只改 `def` 不会覆盖已经生成的 `config`；只改 `config` 则在重装或重建配置后可能回到默认值。本次两处同步修改并重启了容器。

验证：

```bash
docker exec trss-yunzai sh -lc '
  grep "^cron:" /root/Yunzai/plugins/auto-plugin/def/autoStrategy.yaml
  grep "^cron:" /root/Yunzai/plugins/auto-plugin/config/autoStrategy.yaml
'
docker inspect -f '{{.State.Health.Status}}' trss-yunzai
```

当次已用 `node-schedule` 直接解析表达式，下一次调度可被正确计算，容器重启后恢复 `healthy`。

查看容器实际时区：

```bash
docker exec trss-yunzai sh -lc 'date; node -e "console.log(new Date().toString())"'
```

如以后在 Compose 中修改 `TZ` 或改变容器时区，Cron 的实际北京时间也会跟着变化；调整时应同时复核本插件、Lotus 和其他 Yunzai 定时任务。

## Git 更新、持久化与冲突

当前 Auto-Plugin 容器仓库在上游 `0098cd4` 之上有两个本地提交：

```text
7972582 20260825134040 discover and refresh new character guides
8d4688f 20260825134825 schedule guide refresh twice daily
```

这样保留了 `git pull` 能力，且在上游未修改同行时可正常合并。但“已提交”不等于今后绝对不冲突：上游若修改 `app/autoStrategy.js` 或 `def/autoStrategy.yaml` 的同一代码区域，仍需要人工解决合并冲突。

更新前执行：

```bash
docker exec trss-yunzai sh -lc '
  cd /root/Yunzai/plugins/auto-plugin
  git status -sb
  git log --oneline --decorate -5
  git fetch origin
  git rev-list --left-right --count HEAD...origin/master
'
```

若工作树非干净，先区分本地修复、用户配置和临时产物，不要直接强制覆盖。

## 回滚

当次调度改动的回滚代次位于：

```text
/mnt/sda4/TRSS-Yunzai/backups/auto-strategy-twice-daily-20260825-140500
```

执行：

```bash
/mnt/sda4/TRSS-Yunzai/backups/auto-strategy-twice-daily-20260825-140500/rollback.sh
```

会恢复上游的每周六 04:00 调度，并重启 `trss-yunzai`。该代次同时保存原文件、修改件、补丁、字面验证记录和可运行回滚脚本。

Mora 路由、Genshin 默认源和 Auto-Plugin 全量发现修复的备份代次位于：

```text
/mnt/sda4/TRSS-Yunzai/backups/guide-routing-fix-20260825-134500
```

回滚后必须再次检查攻略文件数、新角色图片格式、命令实际路由和容器健康状态，不要只看脚本退出码。
