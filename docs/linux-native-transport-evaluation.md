# Linux 微信读取改进与原生发送评估

核查日期2026-11-05。用户要求先落地可以复用的读取改进，同时评估叙间及公开原生发送候选；叙间目前只有用户提供的《叙间微信连接与会话读取实现说明》，用户正在向作者询问源码，本轮先按公开候选评估。本文不把“Docker支持调试”或“项目声称支持Linux Docker”视为当前微信内部发送已适配。

## 当前结论

rococo-root2上的两个微信桌面均为Ubuntu24.04、x86_64、原生Linux微信4.1.13.23，程序是ELF。当前稳定路线是Chatlog Reader读取授权群数据库，MaiBot规划生成，再由Bowxt界面队列发送并从数据库独立回读确认。新账号Tatsumisaki的独立Reader和MaiBot仍待接入，不复用RyuBuddy的密钥或资料。

原生发送本轮尚无可直接接入当前版本的组件。下面列出的公开项目分别存在平台、微信版本或实现范围不匹配；这是对这些已核验候选的判断，不是声称所有公开项目都不支持Linux。当前发送路线保持不变。

## 叙间设计与当前实现对照

| 设计点 | 现状与本轮处理 |
|---|---|
| 账号选择、群原生ID、账号切换代次 | 已有独立业务空间、Reader账号绑定、群白名单与epoch；保留当前实现 |
| 登录期取钥、页面认证、密钥保护 | RyuBuddy的Linux4.1.13.23取钥及解密已验证，永久服务只读原库，密钥独立加密保存；Windows调试脚本及DPAPI实现不直接移植 |
| DB/WAL快照、分库Name2Id、来源去重 | 已使用固定chatlog-keeper codec；每分库解析身份，来源键包含账号、群和服务器消息ID，回读不按正文去重 |
| 文件活动触发、多个群共享账号读取 | 已有inotify和共享读取器；维持用户指定的正常空闲不扫描原库，不搬入叙间5秒兜底扫描 |
| 首次监听与暂停恢复边界 | 已有尾部游标与不重放；本轮修复尾部接口只读内存元数据，避免读取无关历史正文和大消息导致启动失败 |
| 分页、处理后确认、独立回执 | 已有按群有序ACK、失败不跳页、总结冻结上界与完整性核对、发送后同群本人及服务器ID回读；不另开第二发送通路 |
| 本机业务正文加密 | 叙间的业务载荷加密与当前Reader私有SQLite归档不同；现归档是权限保护的敏感数据，不能宣称其正文已加密。若迁移需另行设计检索、备份和存量兼容，本轮不改账本格式 |
| C++内部发送组件 | 文档只描述内部通道与命名管道，没有给出具体注入技术和Linux适配证据；等待源码时先完成公开候选与基础能力评估 |

## 已实施的读取修复

旧`/v1/stream?after=tail`通过`page(chat,0,1)`取水位，仍会打开归档并取出第一条历史正文；若该条正文超出响应预算，建立实时游标或恢复监听会得到413，即使调用者根本不需要这条正文。

新增`Engine.tail(chat)`在与同步相同的锁内取得已提交归档的epoch、水位和切换时间，只返回内存元数据，不打开归档或微信原库。HTTP鉴权、精确群白名单、接口字段和客户端协议保持不变；不更改旧epoch、seq、游标、积分或发送证据。覆盖超大首条历史、只读内存、空群、不可用来源及未授权请求的回归已完成。部署证据在当天进度补记。

## Docker基础能力实测

使用固定微信镜像，在全新、断网、只读、UID1000且未挂载账号数据的临时容器中，只对脚本自己fork的子进程测试。未增加capability，CapEff为0、seccomp为过滤模式；TRACEME、PEEKDATA、POKEDATA、process_vm_readv均通过，子进程确认缓冲区修改正确。证据见[实验记录](evidence/linux-native-transport-2026-11-05.json)，复现工具见[实验说明](../integration/native-transport-evaluation/README.md)。

这证明当前默认容器边界下存在可用的同UID调试原语；不证明微信本身的dumpable状态、内部函数地址、ABI、线程要求、调用返回值或真实送达已验证。Linux权限条件依据[内核Yama说明](https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html)，容器系统调用限制依据[Docker seccomp说明](https://docs.docker.com/engine/security/seccomp/)。本轮未读取真实微信内存、未提取密钥、未执行微信注入或真实发送，也未改变运行容器的安全参数。

## 公开候选核验

| 候选 | 官方仓库证据 | 对当前环境的结论 |
|---|---|---|
| chatlog-keeper固定提交2225294 | [Linux说明](https://github.com/labazhou2024/chatlog-keeper/blob/2225294fd0761e10ce15540f21e7dbb2ac304c3c/docs/linux.zh.md)、[Linux取钥实现](https://github.com/labazhou2024/chatlog-keeper/blob/2225294fd0761e10ce15540f21e7dbb2ac304c3c/chatlog_keeper/linux_key.py) | 当前已用作读取/取钥基础，不能据此推导具备内部发送能力 |
| jwping/wxbot | [Dockerfile](https://github.com/jwping/wxbot/blob/main/docker/Dockerfile)安装Wine并复制wxbot-sidecar.exe；[README](https://github.com/jwping/wxbot)面向3.9.8等Windows版本 | Docker部署包含Windows兼容环境，不是适配现有原生Linux4.1.13.23的直接组件 |
| lich0821/WeChatFerry | [官方README](https://github.com/lich0821/WeChatFerry)使用VS2019、sdk.dll，已列适配3.9.12.51 | Windows组件和版本均不匹配，不能因有Docker客户端就直接接入 |
| leeguooooo/wechat-use | [平台说明](https://github.com/leeguooooo/wechat-use/blob/main/SKILL.md)明确无受支持Linux原生运行时 | macOS后台发送与实验Windows实现不适用于当前Linux桌面 |

本轮没有下载或执行这些候选的注入器，没有更换微信或引入Wine。后续拿到叙间源码/包后，先核对active_key及native_transport的平台分支、构建说明、Linux函数定位与版本指纹；若只有Windows实现，应拆分为“可复用的上层协议/回执”和“必须重做的Linux底层”，不能用安装PowerShell代替平台适配。

## 原生发送进入运行环境前的验证项

需有可审核Linux构建与当前微信二进制匹配依据，精确账号/会话绑定、幂等请求及持久发送证据、明确失败与不确定状态、从独立数据库回读确认，以及保留原发送路线的受控切换。对未知提交结果不能自动改走另一条发送路线，避免同一条消息发送两次。真实微信进程操作的范围与回退需具体确定后再执行；当前不把候选评估结果写成已接通功能。
