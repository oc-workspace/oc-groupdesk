# Linux 微信读取改进与原生发送评估

更新日期2026-11-07，Asia/Singapore。已核对用户提供的叙间0.1.73相关源码、公开候选及当前Linux微信二进制。11月5日的自建子进程调试原语实验之后，11月7日补充了静态发送线索、合成桥接测试和真实微信的短暂附加退出验证。原生消息发送仍未验证；动态库可加载、调试权限可用和发送函数可正确调用分别验收。

## 当前结论

rococo-root2上的微信运行环境为Ubuntu24.04、x86_64、原生Linux微信4.1.13.23，程序是ELF。当前稳定路线是Chatlog Reader读取授权群数据库，MaiBot规划生成，再由Bowxt界面队列发送并从数据库独立回读确认。Tatsumisaki已完成独立Reader与MaiBot接入，账号切换和隔离状态见[多机器人管理](multi-bot-management.md)；本轮只在当前活动账号中核对用户指定的测试联系人，不复制其他账号的密钥、资料或队列。

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
| C++内部发送组件 | 0.1.73源码已确认Windows DLL注入：Python调用VirtualAllocEx、WriteProcessMemory、CreateRemoteThread和LoadLibraryW，DLL通过内部函数发送；原生布局解析依赖Windows PE/x64。提取包未提供可用Linux发送组件，不能改成.so后直接使用 |

## 已实施的读取修复

旧`/v1/stream?after=tail`通过`page(chat,0,1)`取水位，仍会打开归档并取出第一条历史正文；若该条正文超出响应预算，建立实时游标或恢复监听会得到413，即使调用者根本不需要这条正文。

新增`Engine.tail(chat)`在与同步相同的锁内取得已提交归档的epoch、水位和切换时间，只返回内存元数据，不打开归档或微信原库。HTTP鉴权、精确群白名单、接口字段和客户端协议保持不变；不更改旧epoch、seq、游标、积分或发送证据。覆盖超大首条历史、只读内存、空群、不可用来源及未授权请求的回归已完成。部署证据在当天进度补记。

## Docker基础能力实测

使用固定微信镜像，在全新、断网、只读、UID1000且未挂载账号数据的临时容器中，只对脚本自己fork的子进程测试。未增加capability，CapEff为0、seccomp为过滤模式；TRACEME、PEEKDATA、POKEDATA、process_vm_readv均通过，子进程确认缓冲区修改正确。证据见[实验记录](evidence/linux-native-transport-2026-11-05.json)，复现工具见[实验说明](../integration/native-transport-evaluation/README.md)。

11月5日结果只证明自建子进程上的同UID调试原语。11月7日进一步验证了真实微信的短暂附加退出，范围见下文，仍不能据此推导内部函数的调用契约或真实送达。Linux权限条件依据[内核Yama说明](https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html)，容器系统调用限制依据[Docker seccomp说明](https://docs.docker.com/engine/security/seccomp/)。两轮均未执行真实微信注入或消息发送，未改变容器安全参数。

## 公开候选核验

| 候选 | 官方仓库证据 | 对当前环境的结论 |
|---|---|---|
| chatlog-keeper固定提交2225294 | [Linux说明](https://github.com/labazhou2024/chatlog-keeper/blob/2225294fd0761e10ce15540f21e7dbb2ac304c3c/docs/linux.zh.md)、[Linux取钥实现](https://github.com/labazhou2024/chatlog-keeper/blob/2225294fd0761e10ce15540f21e7dbb2ac304c3c/chatlog_keeper/linux_key.py) | 当前已用作读取/取钥基础，不能据此推导具备内部发送能力 |
| jwping/wxbot | [Dockerfile](https://github.com/jwping/wxbot/blob/main/docker/Dockerfile)安装Wine并复制wxbot-sidecar.exe；[README](https://github.com/jwping/wxbot)面向3.9.8等Windows版本 | Docker部署包含Windows兼容环境，不是适配现有原生Linux4.1.13.23的直接组件 |
| lich0821/WeChatFerry | [官方README](https://github.com/lich0821/WeChatFerry)使用VS2019、sdk.dll，已列适配3.9.12.51 | Windows组件和版本均不匹配，不能因有Docker客户端就直接接入 |
| leeguooooo/wechat-use | [平台说明](https://github.com/leeguooooo/wechat-use/blob/main/SKILL.md)明确无受支持Linux原生运行时 | macOS后台发送与实验Windows实现不适用于当前Linux桌面 |

没有下载或执行这些候选的注入器，没有更换微信或引入Wine。11月7日核对叙间active_key和native_transport后，确认可复用上层协议、调度及回执设计；Linux底层仍需独立实现。提取包虽有linux_key等导入分支，但相关Linux底层模块不完整，不能将平台分支的存在视为可运行支持。

## 2026年11月7日调研与测试

### 公开源码筛选

使用Exa从Linux原生发送和进程内函数调度两个方向进行了3次定向检索，每次返回10条结果，共30条检索结果；检索命中不等于30个可用组件。对相关原始仓库核对后，继续排除Windows DLL、界面自动化和只读取钥的方案。

| 候选 | 原始仓库中的实现范围 | 对本项目的意义 |
| --- | --- | --- |
| [djasdh/wechat-bridge-linux](https://github.com/djasdh/wechat-bridge-linux) | README明确发送经AT-SPI2和键鼠操作 | Linux原生客户端的自动化桥，不能算微信内部函数发送 |
| [wx-11/MimicWX-Linux](https://github.com/wx-11/MimicWX-Linux) | 发送经X11 XTEST及界面控件，取钥另用GDB | 不满足脱离聊天窗口的内部发送目标；不采信零风险宣传 |
| [icepie/linux-wechat-notify](https://github.com/icepie/linux-wechat-notify) | GDB断点读入站消息，构建相关 | 可参考版本约束，未提供原生发送实现 |
| [wildalley/wechat-antirecall-linux](https://github.com/wildalley/wechat-antirecall-linux) | 对4.1.1.8的运行时防撤回Hook，Build ID不同 | 可参考严格指纹和未知版本停用；防撤回不证明发送可用 |
| [zhusinian/wechat-shot-bridge](https://github.com/zhusinian/wechat-shot-bridge) | 4.1.1.4的截图内部调用，Unix Socket加GLib主循环调度 | 仅作结构参考，版本和功能均不匹配；README未声明许可证，本轮不复制其实现 |

在这些已核对候选中，没有取得适配当前构建的完整Linux原生消息发送实现；这不是对所有公开或私有项目的否定。

### 当前构建的静态发送线索

只读复制微信公开可执行文件，在无账号挂载的断网容器中分析，没有执行该文件。精确构建为：

```text
SHA256 2ca28ea56b1a400543d0128ebaf0b93f88172dd66dc0426d3d74fdb971eab959
Build ID ce28c3471d532eeb1f136482eeb4d0bdfd59c06e
ELF64 little endian x86_64
```

通过ELF异常展开表、RIP相对引用及objdump交叉核对，4组发送相关字符串定位到6处有效指令引用。文本管理器不可用分支位于`0x6f8f0d0`起始的异常展开范围；文本发送失败分支位于`0x6f90740`起始范围。图片、文件错误分支也已定位。异常展开范围只用于约束分析，不能直接当作已验证的可调用签名。

文本包装分支能看到类型1写入和候选接收者、正文的复制，以及共享引用计数、回调队列和后续任务调度。Linux侧出现的字符串使用、64位引用计数操作和48字节可调用对象槽，与朋友Windows代码中的32字节字符串、32位引用计数和64字节std::function假设不同。上述布局差异来自静态观察；实际参数语义、线程及任务上下文、异步回调与对象释放仍须验证，不能直接执行这些候选地址。

静态工具只接受锁定SHA256的公开文件，拒绝未知指纹；通过反汇编确认引用确实位于指令边界，避免将立即数字节误当指令。不包含进程发现、内存访问、密钥、动态加载或发送功能。实现及复现命令见[研究工具](../integration/native-transport-evaluation/README.md)。

### 合成桥接测试

在固定微信基础镜像中，以UID1000、断网、只读根文件系统、256MiB内存上限和空tmpfs运行原创的自建宿主及动态库。没有挂载账号、桌面、Docker socket或宿主PID空间。

LD_PRELOAD和dlopen两种加载模式均通过：同UID Unix Socket通信、0600端点权限、由宿主主线程执行回调、相同请求ID不重复执行、非法请求拒绝、正常退出和套接字清理。没有动态库时的宿主拒绝路径也通过。

这些结果只验证本项目自建桥接夹具，不能证明真实微信加载、其主循环或协程上下文、C++ ABI或发送成功。

### 真实微信的附加退出

用户授权了指定联系人测试。先在当前活动账号的联系人库中按精确微信号查询，唯一匹配且不是群；只输出匹配结果，不在本报告或证据中保存联系人标识、密钥或聊天正文。

运行端空闲后，在无账号挂载的临时工具容器中使用同UID和该微信容器的PID命名空间，按精确可执行文件SHA256核验目标。PTRACE_SEIZE、PTRACE_INTERRUPT、等待停止和PTRACE_DETACH完成，操作区间约2.152毫秒；退出后TracerPid为0，主进程为睡眠态，微信容器启动时间不变。

该操作没有读取或写入进程内存、没有设置断点、没有加载动态库，也没有调用微信函数。未增加capability，未修改Yama或seccomp。它验证的是实际附加退出权限，不是原生发送能力。真实进程实验需要按每次目标和作用范围核对，不由合成测试脚本接受任意PID复现。

### 实发状态与下一项验证

本轮真实消息发送数为0；用户指定的联系人尚未收到测试消息。没有通过界面发送来冒充原生发送成功。

下一项应完成当前构建的消息构造、结果回调及调度上下文契约，先验证无发送副作用的组件生命周期。具备可核验的调用实现后，真实测试仍限定到已授权的唯一联系人和一次提交；结果未知时查询原请求和独立数据库证据，不自动重试或切换另一条发送通路。账号节奏和人机接管沿用[消息机制优化方案](message-mechanism-optimization.md)。

本轮结构化证据见[2026年11月7日实验记录](evidence/linux-native-transport-2026-11-07.json)，包含公开构建、静态引用、合成测试、真实附加退出和明确未验证项。

## 原生发送进入运行环境前的验证项

需有可审核Linux构建与当前微信二进制匹配依据，精确账号/会话绑定、幂等请求及持久发送证据、明确失败与不确定状态、从独立数据库回读确认，以及保留原发送路线的受控切换。对未知提交结果不能自动改走另一条发送路线，避免同一条消息发送两次。真实微信进程操作的范围与回退需具体确定后再执行；当前不把候选评估结果写成已接通功能。
