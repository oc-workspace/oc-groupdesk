# 群间 GroupDesk

按群管理微信机器人的话题、回复语言、知识库和私聊场景权限。中文管理后台，自托管于 rococo-root Docker。

## 功能与架构

React/Vite + TypeScript/Express + PostgreSQL 16 + 独立文档 worker。

- 群管理：真实群 ID 绑定、独立启停、话题勾选、回复语言/覆盖策略、回复方式、知识库关联。
- 话题库：可复用说明与回复规则，修改后增加关联群的配置版本。
- 知识库：文字录入、TXT/Markdown/文字型 PDF 上传、异步分片索引、检索测试、失败重试及删除。
- 私聊：管理员核验稳定用户身份与群归属；成员选择已授权群场景；撤销即时生效。
- 机器人 API：按群过滤资料，返回语言/话题/来源/独立会话作用域，实际应用后确认版本。
- 审计、密码管理、数据库迁移、Docker 持久化、备份恢复。

第一版为关键词及中文双字检索，不需要 embedding API。扫描型 PDF 不含 OCR。检索测试展示资料，不生成模型回答。

## 开发和发布

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

## 生产位置

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

新群及两个示例群默认停用、未绑定真实群 ID。机器人连接未确认前不显示配置已应用。

初始密码仅在数据库初始化时使用。之后网页改密或从 stdin 调用 npm run admin:reset。
改密后全部会话失效，初始登录文件不会自动更新，应在首次改密后删除该文件。

## 验证命令

开发机：npm run build && npm test。

在隔离桥接目录：

    docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from test
    docker compose -f compose.test.yaml down --remove-orphans

集成测试仅允许 groupdesk_test 数据库，覆盖认证、CSRF/来源检查、绑定/并发写入、
文档上传/检索、成员核验、跨群隔离、私聊场景切换/过期/撤销、语言策略、配置确认和注销。

## 备份与恢复

scripts/backup.sh 短暂停 app/worker，确保数据库与附件一致，结束后自动启动。
输出：/opt/docker/backups/groupdesk/<timestamp>，含数据库 dump、附件、发布 SHA 和校验和，不含密钥。
备份包含私有资料，应保持目录 0700、文件 0600，并另做加密异地备份；密钥另行加密保存。

scripts/restore.sh <backup-dir> --replace-current-data 验证校验和，停服务后恢复；失败时保持停止。
需使用与备份兼容的代码和数据库版本；旧附件目录保留。先在独立数据库进行恢复演练。
应用回退保留旧镜像和版本目录；迁移自动向前执行，跨不兼容结构时必须同时恢复对应备份。

## 适配器接入边界

docs/runtime-api.md 和 integration/groupdesk-client.mjs 描述接入协议。后台不会自动修改另一台机器 rococo-root2 的现有 MaiBot。
现有 UI 桥的 ui- ID 来源于昵称和群，不能作为跨群/私聊身份凭据。在具备可信稳定身份前，不启用自动成员核验。

服务器强制执行资料权限；话题语义判断、会话隔离和回复频率由接入的机器人执行。
机器人在接口拒绝或超时时必须停止，不得回退到旧群资料。版本确认表示适配器报告已应用，不能证明适配器实现正确。

## 日志

[当前进度](docs/progress/README.md)
