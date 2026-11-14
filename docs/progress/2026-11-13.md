# GroupDesk 机器人运行环境变更（2026-11-13）

- 控制面仍在 `rococo-root`。当前发布目录：`/opt/docker/groupdesk/releases/rpi-workflow-20261113d`；原发布目录保留，控制表备份位于 `/opt/persist/groupdesk/backups/host-change-20261113/control-before.dump`（仅服务器 root 可读）。
- 新增独立主机 `rpi-groupdesk-01`。树莓派维护代理使用该身份上报；原 `rococo-root2` 主机登记已禁用，源代理服务保持停用。
- Tatsumi 在用户完成手机确认后，微信、Reader、MaiBot 与本地就绪上报均通过核验；源端四个容器停用、树莓派新盘点无阻断。其迁移记录已完成，`host_label` 与 `runtime_host_id` 均为 `rpi-groupdesk-01`，机器人仍为 `paused` 且发送关闭。
- RyuBuddy 按用户要求本次不登录；迁移记录保持 `approved`，原主机登记暂留 `rococo-root2`，机器人保持 `paused`。
- 树莓派代理的只读盘点找到两个机器人，均无资源阻断项。GroupDesk 的启用接口在迁移记录未完成时拒绝启用。
- 现场核验顺序：确认源端微信停止；核对数据和目标 Reader、MaiBot；由用户完成目标微信手机确认；检查连接和队列；管理员在“运行环境变更”完成核验并提交登记；最后按机器人启用流程逐个恢复发送。此流程不自动登录微信、不采集二维码或密码。
- 上海群及其他已接入群中迁移暂停期间漏掉的点名，将在 Tatsumi 首次启用后从 Reader 历史逐条核对并补回复；不按消息年龄过期。未知发送者、无法确认微信原生 @ 或不确定的发送结果保留待人工核对，不能当作已回复。
- 若在完成登记前回退，先停目标端微信与桥接，再取消变更记录；确认单端运行后才可恢复源端。若已完成登记，应发起反向主机变更，不直接改数据库标签。
- 测试：本地构建、140 项单元测试、专门迁移集成测试及受影响的旧版清理集成测试通过。隔离全套集成测试的两项摘要来源缓存相关旧版清理失败，在未修改的原发布版本同样复现，且该路径目前安全地拒绝清理。

## 首次启用补回复（2026-11-13）

- Groupdesk 当前发布指针：`/opt/docker/groupdesk/releases/migration-launch-20261113a`，app 镜像 `groupdesk:migration-launch-20261113b`。仅 app 镜像更新，两个 worker 沿用此前已健康的版本。
- 启用按钮和接入向导启用入口都会要求明确选择寒暄群（允许零个）；服务端拒绝没有提交选择的迁移首次启用。勾选只决定寒暄群；补回复扫描 Tatsumi 连接配置绑定的所有群。
- Tatsumi 运行端新建一次性持久队列：先逐群发随机风格的搬家返岗寒暄，再按 Reader 记录扫描从 `pause_requested_at` 到启用时刻的历史。识别已回复的点名后不再排队，余下逐条交给原 MaiBot 回复路径，旧消息按当前时间入队以避免普通队列的十分钟旧消息拒绝；原始时间随请求提供给模型。
- 迁移补回复要求群成员微信原生 @；无法安全取得成员昵称或 @ 选择失败时标记待人工核对，不退化成不带 @ 的补回复。每次发送前持久预留，未知结果不自动重发。管理页显示寒暄及补回复进度。
- 树莓派只重建 Tatsumi 的 `wechat-bridge` 容器，微信、Reader、MaiBot 未重启。部署后桥接仍为 `enabled=false,send_enabled=false`，微信连接保持 `true`，Tatsumi 在 Groupdesk 仍为 `paused`，上线记录数为 0。
- 预检 Reader 历史：Tatsumi 绑定 5 群，迁移暂停窗口内合计 715 条消息；只输出计数，不提取聊天内容到本机。隔离构建通过 140 项单元测试，专门数据库集成测试通过；Python 历史补回复测试 4 项通过，使用树莓派当前 MaiBot 镜像和生产同版发送模块的原生 @ 测试 7 项通过。
- 首次 app 切换因新迁移文件未命名为控制库专用而失败，已立即回切并确认上一版健康；改为 `042_bot_migration_launch_bot_control.sql`、重跑测试后再次上线，app 健康。数据库服务器本地备份：`/opt/persist/groupdesk/backups/host-change-20261113/control-before-launch.dump`，SHA-256 `bcfbbb5a90e43af012adfad5cd662b97076e8ce0a4fbf7c9748ced8147bfa5ef`。此前错误迁移名留在 `schema_migrations` 历史记录中，表结构与新控制库迁移一致。
- 最终预检发现树莓派到 `groupdesk.rococo.dev` 超时：DNS 指向 rococo-root 当前公网 IP `152.53.55.239`，原临时精确路由仍指向旧 IP。新增 `groupdesk-control-route.service/timer`，按现有路由规范每五分钟刷新该域名的 IPv4 单目标直连（优先级 8994），不改变微信出口路由。HTTPS 恢复 200，Tatsumi 控制面心跳恢复到 9 秒内；桥接健康字段旧错误在成功同步后清除。Reader 预检可读取 5 群、迁移暂停窗口累计 715 条历史消息。机器人仍暂停、发送关闭、微信连接正常。
- 随后公网 IPv4 到两台服务器再度超时；根因与树莓派本地代理证书错误叠加。已给 rococo-root 固定 IPv6 加目的地址单独路由（优先级 8994），并安装仅监听 Docker 主机网关的 `groupdesk-control-relay.service`，把 Tatsumi 桥接的 `groupdesk.rococo.dev` 映射到 `host-gateway`。TLS 由桥接直达 Groupdesk，转发器不解密；微信容器和出网规则未修改。桥接内 HTTPS 200、心跳正常，`wechat`、Reader、MaiBot 的重启计数均为 0。未来若 rococo-root IPv6 变更，要同步更新转发器目标与专用路由。
- 上海群暂停窗口有 2 条含 Tatsumi 点名的微信“引用回复”消息，Reader 将其标为 49 类文本。补回复扫描已扩展到该类型及直接引用机器人消息，并改为每条机器人回复最多抵消一条旧点名，避免连续点名时误判已回复。只读盘点仅输出了计数与消息类型，未复制聊天正文到本机。Python 专项测试增至 6 项并通过。
