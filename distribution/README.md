# GroupDesk 独立安装包（隔离验收版）

仅站点系统，不含现有机器人、群、聊天、用户、Key、私人 Persona 或微信登录资料。不会连接原站点、自动安装微信或启用群回复。第三方 Skill 不随包分发，提供独立编写的五版基础总结模板；可按许可自行导入其他资源。

## 准备

Python 3.10+、Docker Engine/Desktop 和 Compose v2。加密备份/恢复另需 GnuPG。Mac/Linux 可运行本工具；Windows 请先在 WSL2 核验 Docker/Python 路径和权限，尚未宣称 Windows 原生验收通过。机器人宿主机须保持开机，站点安装成功不代表微信读取和收发已接通。

核对 SHA256SUMS 后解压，在发行包根目录构建。首次构建需联网获取官方 Node/PostgreSQL 镜像及 npm 依赖，绝不使用私有恢复镜像。

```sh
docker build -t groupdesk-standalone:20261120-rc6 .
python3 distribution/manage.py init --target /your/new/private-instance --project gd-my-site --image groupdesk-standalone:20261120-rc6 --port 3110
python3 distribution/manage.py up --target /your/new/private-instance
```

init 会隐藏输入管理员密码，生成本实例独立数据库密码、加密密钥和机器人令牌；已有目录/端口/同名 Docker 项目会停止，绝不覆盖。配置保存在目标的 config 目录（0600），不要上传或贴到聊天。新站点仅数据库和网页启动，业务空间为空。

登录后登记自己的机器人，按“自己的电脑 / 自选服务器”向导接入。本人添加 Key，或向本站管理员申请公用 Key；不继承任何付费额度。GitHub OAuth 使用自己创建的 App，在系统设置查看并填写本站回调 URL。

核对模型和计划后，显式 `up --workers` 才启动后台任务。init 加 `--isolated` 时应用网络禁止公网出站，且工具禁止开启 worker，适用于恢复演练；某些 Docker 环境也不会转发此内网的网页端口，应在容器内检查健康。网页仅绑定本机回环；公网部署需自行配置 TLS/域名，并使用 `--origin https://your-domain.example`。proxy.example.conf 提供宿主机 Nginx 范例，不接入原站点的共享网络。

## 加密备份与恢复

在可信设备单独保存恢复口令文件（0600），或使用 GPG 的交互输入；不把口令放到命令参数中。

```sh
python3 distribution/manage.py backup --target /your/private-instance --output /private/site.gpg --passphrase-file /private/recovery-passphrase
python3 distribution/manage.py init --target /your/new/restore-test --project gd-restore-test --image groupdesk-standalone:20261120-rc6 --port 3111 --isolated
python3 distribution/manage.py restore --target /your/new/restore-test --source /private/site.gpg --passphrase-file /private/recovery-passphrase --confirm-empty-target
```

备份暂停本实例写入，成套保存控制库、机器人业务库、角色、资料文件、配套密钥/配置和每个服务的实际镜像（可为不同版本），完成后恢复原服务。归档加密后完整解密逐文件核验。

这是站点备份；微信本地目录、Reader 密钥、MaiBot 等运行目录必须在各自宿主机另行备份，不能把站点备份当作整机备份。

恢复仅允许新的、未启动且数据为空的目标。先逐表核对原始内容，再由新系统迁移、验证凭据解密；清除旧会话/设备连接，暂停机器人、维护许可、总结计划，取消旧发送/删除任务和未完成的模型制作/分析任务；旧设备审批和配对码须重新确认，防止恢复后重放或意外消耗额度。只启动新包的网页，不启动 worker。查看目标的 restore-validation.json，然后由本人重新连接设备、确认账号和群。

也支持维护备份的 site 格式（FINAL-MANIFEST.json、databases、roles.sql、containers.json、files-and-release.tar.gz）及其加密包；可用于隔离恢复当前生产数据，绝不把私有数据加入公共安装包，也不自动加载旧镜像。生产环境不在此工具的覆盖范围。

不自动迁移、替换或删除旧实例。微信恢复可能需要扫码或手机确认。运行主机由管理员用受控注册工具登记，新增主机不自动开放任意路径清理能力。

## 离线镜像包

离线版包含 `images.tar.gz` 时先执行 `docker load -i images.tar.gz`，再按镜像清单填写 `--image`，无需重新构建。该镜像包仅适用于清单记录的架构；ARM 设备使用源码包在自身架构构建，不要强行把 amd64 镜像当作已验收的 ARM 运行环境。

运行主机可由管理员在可信环境执行 `node --import tsx scripts/provision-runtime-host.ts HOST NAME https://your-domain.example /tmp/new-private-agent.json` 登记（在本实例 app 容器内运行）；输出文件为私有配置且不会覆盖已注册主机，默认不开放清理。将配置交给自己主机的维护适配器，不能把别人的主机令牌复制过来。已有部署入口需单独核验，注册不代表已安装机器人环境。
