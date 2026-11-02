# Docker Chatlog Reader

用于已授权账号的Linux微信4.1.13.23，独立于Bowxt读取数据库。MaiBot实时入站、GroupDesk总结与恢复扫描共用此来源；Bowxt仍通过原有可见界面队列发送消息。上游固定为chatlog-keeper 2225294fd0761e10ce15540f21e7dbb2ac304c3c（MIT）。不是imldy/chatlog，也不修改WeChat协议。

## 目录与边界

- 代码：`/opt/docker/oc-projects/chatlog-reader/releases/<production-sha>`，current指向已发布目录。
- 持久化：`/opt/persist/chatlog-reader/{config,secrets,client,data,key-import,backups}`，目录0700、凭据0600、UID1000。
- 永久reader只读挂载一个账号的db_storage，仅索引配置白名单中的群。没有公开端口，内部Docker网络不出公网。
- 解密数据库快照只在容器tmpfs；密钥用RSA3072/OAEP-SHA256信封加密持久化。一次性bootstrap只得到公钥；明文密钥只在进程内存，不进入仓库、日志或页面。
- archive.sqlite3是指定群的规范化记录，含敏感聊天内容。按私有业务数据备份管理，不上传仓库。联系人备注不作为成员公开昵称。
- 只覆盖该服务器微信已同步的数据；文字、时间、姓名及可解码的媒体摘要可用，未同步历史或媒体原文件不在首版范围。

## 构建与发布

遵循项目开发服务器oc-push、生产发布桥oc-prod-release、核对PR准确head及diff并合并后部署的既有流程。prepare-inputs.py验证inputs.lock.json中的公开源码、wheel和离线依赖摘要；inputs不入库。

1. 在可用构建机准备已校验inputs，离线构建Dockerfile的test/production目标，运行33项隔离合成测试。
2. 在root2使用build.sh构建一次性bootstrap工具镜像。基础镜像ID由脚本核对，不从外网拉取。离线验证gdb能追踪同容器UID1000的测试子进程。
3. sender镜像基于已验证微信基础镜像，inputs/native-bowxt须来自当前生产公共源码，经native-patch.py修改。完整SDK测试通过后固定镜像ID；禁止仅复制单文件而丢失既有热修复。
4. 从已合并生产提交导出本目录及相邻maibot/chatlog_runtime.py；manage.py prepare --image sha256:... --bootstrap sha256:... 创建白名单、保密目录和密钥公私钥。不会开始取钥。
5. 用户已明确授权加密保存与受控启动时，manage.py capture暂停新任务、等已接纳任务完成、暂停发送及巡检；同桌面可见启动取钥，可能需要本人手机确认。结束后恢复原微信与旧数据源，失败也恢复；UI未恢复时保持发送暂停，并提示运维执行resume。
6. reader健康后manage.py cutover --sender-image sha256:...，校验所有公开代码基线，备份配置及账本，切换内部网络与客户端令牌；首次游标从当前尾部建立，不重放历史。send_only保留原发送队列、暂停和输入安全锁，停止自动UI读消息与资料卡补读。
7. 检查源健康、群隔离、游标和容器重启复用密钥；总结只做SSH群预览，不向Shanghai发送测试。

所有运行进程均在Docker中；manage.py仅是主机部署命令，不新增主机常驻采集进程。credentials为一次性Compose profile；bootstrap-artifacts是仅提供公开工具的固定Docker镜像容器，平时不创建。取钥时临时在原微信Docker内以UID1000运行，复用真实桌面连接，结束即清理工具及加密中转目录，不把桌面套接字共享给其他容器。

## 运维

Docker Compose永久服务使用compose.yaml与外置.env。token只给bridge，私钥不给bridge。手动保存配置、原积分与发送账本保持不变。数据库来源不可用时暂停读取并由既有每小时巡检告警，不偷偷回退UI采集、不盲目重启微信。

原maibot项目使用`compose.yaml`与`compose.chatlog-reader.yaml`叠加管理bridge。维护时不要用只含基础compose的force-recreate覆盖bridge配置。已更新WECHAT_IMAGE为包含全部当前修复和send_only的新镜像，下次重建微信仍可用；构建脚本末段保留幂等补丁钩子。

回滚：`python3 manage.py rollback --backup <cutover输出的私有备份目录>`。先核对manifest摘要，恢复公开源码、旧镜像设置和旧模式，不回滚积分/消息/发送账本，避免重复回复或积分倒退。新加密数据可保留供诊断；不要删除微信持久目录。
