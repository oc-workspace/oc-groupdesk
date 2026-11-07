# 运行状态、告警与运维

## 状态的区别

配置已保存、机器人已确认、在线健康、任务生成成功和微信消息送达互不等同。配置确认只在管理员手动刷新时查询，不每5秒轮询；未保存更改不被后台状态替换。微信在线巡检默认每小时，读取进程/线程、连接与事件监听状态，和配置应用确认分别显示。

微信写库通过Linux inotify触发Reader增量同步；正常空闲没有2秒或15秒原库扫描。启动、手动历史任务、通知溢出和已触发失败的有限重试按Reader说明执行。微信需登录、锁屏、搜索框不可见或界面异常时，停止受阻发送，不猜已送达、不盲目重发。

## 告警

后台系统设置维护独立微信故障通知通道。接入Token、目标地址和模型/数据库密钥只保存在私有配置，不写入日志或浏览器明文回显；正常且无变化时不重复刷告警。告警渠道与微信群回复分开，不能把测试告警发到未授权群。

## 发布与备份

必须遵循用户指定的[开发与生产发布脚本说明](https://github.com/oc-workspace/openclaw-workspace/blob/main/openclaw-开发与生产发布脚本说明.md)：开发机oc-push，生产桥oc-prod-release，审核准确head和差异并合并，备份后使用Docker发布。当天最后一次推送前更新`docs/progress/YYYY-MM-DD.md`和索引。

GroupDesk生产代码在`/opt/docker/groupdesk/releases/<sha>`，current指向已部署版本；持久化在`/opt/persist/groupdesk`。`scripts/backup.sh`先停止相关写入进程，备份数据库、素材、版本及根用户可读的密钥恢复文件，记录SHA256。恢复遵循`restore.sh`与摘要校验，不能把旧业务账本覆盖到仍在运行的新消息/积分上。

root2机器人与Reader用独立Compose和外置持久化；维护时同时指定基础和Reader覆盖Compose，避免丢失网络与凭据挂载。变更前检查源码/镜像摘要，等待已接纳任务结束，备份SQLite并quick_check。增量更新优先只重建必要容器，避免不必要的微信重新登录。密钥加密保存，解密快照只在tmpfs。

多机器人后各自记录状态、操作、队列与备份；控制面统一管理员身份。新增账号的微信登录仍需本人扫码/手机确认。后台不挂载Docker socket，也不接受用户输入的任意Shell命令；实际容器部署由受控的部署工具完成。

## 等待中的加载反馈

### 界面表现

- 后台接口请求期间，页面右上方显示转圈和操作说明，涵盖读取数据、保存、导入、查询模型目录、AI话题助填和新群配置建议。并发请求各自结束才清除，不用其中一个请求的完成掩盖另一个仍在等待的操作。
- “读取微信本地群 / 按指定群名读取”按钮在请求提交、排队、运行端读取期间持续显示等待状态，防止重复提交；成功后恢复按钮并展示群列表，失败保留错误及重试入口。
- “生成配置建议”按钮与表单显示AI分析中，完成后展示建议供采纳，失败恢复编辑；不会自动接入或发送消息。
- 群接入、连接检查、问候、Persona制作、讨论分析、总结任务另有后台处理中提示，避免HTTP提交结束就误以为任务完成。Persona和总结显示最近一次读取的状态，仍需原有的手动刷新；不新增定时查询。
- 新群接入沿用既有的进行中自动更新及15分钟上限；自动更新暂停或失败时提示手动刷新，不假称结果已实时确认。任务成功/失败后停止相应加载。
- 初始页面加载失败时停止初始加载并显示错误，可重试；接口失败、取消和异常都清理请求状态，不展示虚构百分比或人为延长等待。

### 实现边界

`shared/request-activity.ts`维护请求ID、固定操作文案和机器人范围，`requestApi`在`finally`结束状态；不存储请求正文、查询内容、Key或路径中的私有标识。切换机器人后不显示旧账号的在途请求。原有新群任务自动查询不重复弹全局提示。

`web/loading.tsx`提供转圈、按钮和无障碍状态组件，支持减少动态效果。新群操作增加同步锁；机器人权限、群配置、模型选择、API时限和发送规则均不改变。

## 部署与恢复操作参考

以下从项目首页归并；首次安装说明不代表当前运行配置，当前状态看后台与每日部署证据。

### 开发和发布

严格执行 https://github.com/oc-workspace/openclaw-workspace/blob/main/openclaw-开发与生产发布脚本说明.md

1. 开发机 rococo-oc-workplace：/work/oc-projects/oc-groupdesk。
2. npm ci，npm run build，npm test。
3. 更新 docs/progress/YYYY-MM-DD.md 与索引，检查 git status --short、git diff --check。
4. source ~/.profile；首次 oc-create-repo，后续 oc-push "提交说明"。
5. 生产机 rococo-root：在 /opt/docker/for-oc-dev2prod 下运行 oc-prod-clone oc-groupdesk。
6. 在隔离检出中运行 compose.test.yaml（专用 groupdesk_test 数据库，tmpfs）。
7. 首次 oc-prod-create-repo、oc-prod-init；后续 oc-prod-release，检查差异并合并 PR。
8. scripts/deploy-production.sh 只从 prod/main 的已发布提交构建 SHA 版本目录。

不得在生产桥接目录提交业务代码。密钥、私有资料不得进入 Git/日志。

### 生产位置

- 站点：https://groupdesk.rococo.dev
- 发布桥：/opt/docker/for-oc-dev2prod/oc-groupdesk
- 版本：/opt/docker/groupdesk/releases/<prod-commit>
- 当前版本：/opt/docker/groupdesk/current
- 数据：/opt/persist/groupdesk/postgres、/opt/persist/groupdesk/files
- 密钥：/opt/persist/groupdesk/secrets/app.env（root:root 0600）
- 初始登录信息：/opt/persist/groupdesk/secrets/admin-access.json（0600）

数据库不发布宿主机端口。应用映射 127.0.0.1:3110，通过现有 Nginx 网络提供 HTTPS。
生成独立随机数据库密码、管理员密码和 BOT_API_TOKEN。files 目录属于 uid 1000。
配置 COOKIE_SECURE=true、PUBLIC_ORIGIN=https://groupdesk.rococo.dev、TRUST_PROXY 为实际 Nginx 容器 IP。
安装 scripts/nginx.conf 前确认目标文件不存在，nginx -t 成功后再 reload。

首次初始化时，新群及示例群默认停用、未绑定真实群ID；这不是当前线上群的实时状态。机器人连接未确认前不显示配置已应用。

初始密码仅在数据库初始化时使用。之后网页改密或从 stdin 调用 npm run admin:reset。
改密后全部会话失效，初始登录文件不会自动更新，应在首次改密后删除该文件。

### 验证命令

开发机：npm run build && npm test。

在隔离桥接目录：

    docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from test
    docker compose -f compose.test.yaml down --remove-orphans

集成测试仅允许 groupdesk_test 数据库，覆盖认证、CSRF/来源检查、绑定/并发写入、
文档上传/检索、成员核验、跨群隔离、私聊场景切换/过期/撤销、语言策略、配置确认和注销。

### 备份与恢复

scripts/backup.sh 短暂停 app/worker，确保数据库与附件一致，结束后自动启动。
输出：/opt/docker/backups/groupdesk/<timestamp>，含控制库与各机器人业务库dump、附件、发布SHA和校验和；当前备份还包括root专用的model-encryption.env恢复文件，不能视为无密钥备份。
备份包含私有资料，应保持目录 0700、文件 0600，并另做加密异地备份；密钥另行加密保存。

scripts/restore.sh <backup-dir> --replace-current-data 验证校验和，停服务后恢复；失败时保持停止。
需使用与备份兼容的代码和数据库版本；旧附件目录保留。先在独立数据库进行恢复演练。
应用回退保留旧镜像和版本目录；迁移自动向前执行，跨不兼容结构时必须同时恢复对应备份。

### 适配器接入边界

docs/runtime-api.md 和 integration/groupdesk-client.mjs 描述接入协议。后台通过可信适配器下发策略；只有适配器实际加载并确认revision才显示已应用。MaiBot接入实现和边界见integration/maibot。
操作说明见[群聊话题与语言管理](topic-policy-guide.md)。
每个群可分别设置 Planner、接口请求超时、点名请求总有效期和等待致歉阈值，见[按群配置等待时间](reply-controls.md)。
话题详情现由topics.policy存储，支持中英文词条、组合/排除、上下文承接和深度；通用skill及初始模板在skills/和catalog/。模板更新不覆盖后台修改。群policy独立控制persona、话题范围、参与程度和输出语言多选。

现有 UI 桥的 ui- ID 来源于昵称和群，不能作为跨群/私聊身份凭据。在具备可信稳定身份前，不启用自动成员核验。

服务器强制执行资料权限；话题语义判断、会话隔离和回复频率由接入的机器人执行。
机器人在接口拒绝或超时时必须停止，不得回退到旧群资料。版本确认表示适配器报告已应用，不能证明适配器实现正确。

### 日志

[当前进度](progress/README.md)

#### 已验证的部署约定

应用同时连接私有数据库网络和现有Nginx网络。现有网络已有名为postgres的DNS别名，
因此DATABASE_URL必须使用本项目唯一的groupdesk-postgres-1，不能使用通用postgres名称。
Compose项目名保持groupdesk。

每日备份使用scripts/groupdesk-backup.service与.timer，时间为Asia/Singapore 04:15。
备份前短暂停止应用写入。当前仅在服务器本地保存备份；加密异地备份需另行配置。

浏览器验收创建的GroupDesk使用指南包含后台操作说明与适配器接入说明，未关联任何群，
不含真实群聊天记录或个人资料。

微信在线巡检及分级恢复见[integration/maibot/availability](../integration/maibot/availability/README.md)。微信在线状态和配置应用确认分开显示；巡检每小时运行，不影响消息采集和配置同步频率。

完整功能与运维说明见[文档索引](README.md)；多机器人管理方案见[多机器人说明](multi-bot-management.md)。
