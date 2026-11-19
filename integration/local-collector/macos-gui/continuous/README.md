# Mac GUI 持续采集

这套组件在本机已登录的微信上读取指定群的结构化辅助功能控件。安装脚本编译 Capture.swift，stream.py 将消息和断点存入本机器人私有 SQLite 档案。首次窗口作为历史基线，后续新消息可通过 GUIAgent 的 claim/ack 接口进入既有 MaiBot 群策略桥。

普通用户继续在 GroupDesk 选择 GUI、下载配套工具、复制安装说明给有本机操作能力的 AI。下面的技术步骤由本地 AI 执行。当前仅有合成数据和编译验收，目标微信构建仍须现场校准，尤其要核实其是否暴露独立消息行、发言人及当前账号。只有文字行或 OCR 结果的版本会停在未适配状态。

## 安装和校准

1. 本人看过安装范围后，运行下载工具的 `install-mac-gui-stream --directory 新私有目录 --report-directory 私有报告目录 --confirm-install`。需要 macOS 14+、Apple 命令行工具和普通桌面用户。组件不下载依赖。
2. 从 `config.template.json` 准备本机器人 config.json，填写真实 bot UUID、固定私有 account UUID、GroupDesk 已绑定群的整数 ID、精确群标题和准确微信构建。为自己及两位知情测试成员登记本地 UUID。配置文件 0600、状态目录 0700。
3. 本人确认专用测试群和辅助功能读取/滚动范围后，用 `stream.py layout --config 配置 --state 状态目录 --capture wechat-gui-capture绝对路径 --confirm-read` 获取无文本结构。可通过 `--path '[索引,...]'` 只检查消息列表子树。确有需要且本人同意后，`--include-values` 会显示该子树文本，只在本机检查人工测试内容，勿上传日常聊天或截图。
4. 填写 profile 中的 header、account、container、sender、body、scroll。每个 selector 用相对 path 和实际 role，必要时额外核对 identifier 或 description。消息列表的每个子节点须对应一条独立消息。纯时间分隔项只可按明确 role+identifier 排除。profile.account_value 须能从实际当前账号字段核对。不要填猜测的身份、路径或整块正文拆分规则。
5. `message_id` 和 `timestamp` 是可选的真实 AX 字段，前者必须每条唯一且稳定，后者必须是含时区的 ISO 时间。没有原始时间时档案保留实际观察时间。没有稳定 ID 时按发言人、正文、方向、时间和相邻上下文对齐，重复上下文无法唯一确定时会暂停。
6. 校准 scroll_step，使相邻历史页有重叠。`composer_top` 只用于可选的短文本发送。用 `stream.py check` 读取当前测试群并报告识别条数，输出不包含正文。

若当前微信构建没有账号字段、独立发言人或可控制的历史滚动条，请在安装记录注明 GUI 布局未适配，保留现有组件。校准失败不会将 OCR 文字行当成具备身份的消息。

## 持续采集与恢复

用 `run-mac-gui-stream --directory 组件目录 --config 配置 --state 同一私有状态目录 --report-directory 报告目录 --confirm-read` 启动。组件独占该状态目录的采集锁。微信界面变化通知唤醒采集，约 12 秒的有界核对补偿缺失的通知。锁屏、切群、账号/构建不匹配、权限失效会在本地 health.json 显示 blocked。

停止按 Ctrl+C。重启始终复用同一个配置、SQLite 和断点。若旧断点不在当前页，向上最多检查 50 页，逐页核对重叠后回到尾部，一次事务提交补读结果。相邻页无重叠、无法确认旧断点或补读期间界面变化时，旧断点保留，重试不会提交半份历史。微信未同步的记录或超过补读界限的部分会报告 history_gap。

补读行有 backfilled 标记，提供历史查询，默认不进入自动回复。采集过程中首次捕获的新消息通过 eligible 标记进入 MaiBot。相同正文来自不同发言人分别记账，同一发言人的相同正文在上下文能够区分时保留为独立消息。界面只给昵称时，sender_id 是账号和群范围内的本地标识。昵称变更、同名成员和完全相同的不可区分视图需额外校准，不能作为微信号身份认证依据。

当前支持一个独占的可操作微信窗口和一个群。多群轮转尚未实现，使用时需要保留该群窗口，避免日常切群干扰。

## 接入既有 MaiBot 策略桥

需要已经准备好的本机器人 GroupDesk MaiBot 运行包，其中包含 bridge/app.py、limits 及 attach_reader 接入点。`install_bridge.py --runtime 运行目录 --expected-sha256 已审阅的app.py摘要 --check` 先列出改动文件。本人同意后使用 `--confirm-install`，保留备份后安装两个源模块及桥入口。此步骤不启动进程。

设置桥进程的 MAC_GUI_CONFIG、MAC_GUI_STATE、MAC_GUI_CAPTURE。配置及档案要能由运行桥的同一用户访问，不能同时选择 CHATLOG_READER_URL。桥仍使用原有群权限、参与规则、Persona、模型与回复队列。

可选的 MAC_GUI_SENDER 指向本机 wechat-gui-sender，需要辅助功能、屏幕录制和已校准的 composer_top。当前发送器限 200 字符的单行文本。发送前核对账号和群，操作 ID 在本地持久化。不确定的发送不会自动重试，GUI 可见结果不充当独立微信送达回执。未配置发送器时仅接入消息读取。

MaiBot 可以在 Docker 中运行，Mac 二进制在原生 Mac 执行。推荐既有策略桥也在原用户环境执行。容器桥需要另行验证挂载权限、UID 和调用 Mac 二进制的方式，不能直接在 Linux 容器运行这套 Capture 程序。

## 验收清单

- 两名知情测试成员分别发不同内容和相同内容，核对本地档案 sender_id、seq、条数和方向。
- 重复采集同一窗口，重启采集后核对旧行不重复。
- 停采后发消息，重新启动，验证向上补读和 backfilled 标记。
- 切群、锁屏、撤销权限后确认 blocked，恢复后从旧断点继续。
- 停止 MaiBot 策略桥后采集几条新消息，恢复桥，核对持久消费位点和只处理一次。桥内部处理失败时同一消息序号重试，过期租约的 ACK 被拒绝。
- 核对桥健康来源 macos-gui、reader.connected 和实际策略接收。站点真实健康与配置应用确认按原流程验收。

`verify-mac-gui-stream` 只在档案已收录两位测试成员的新消息后记录真实 GUI 读取方式。断线补读和 MaiBot 联调仍须完成以上实机清单。安装摘要只上传枚举、版本、读取方式和错误原因，不含消息、截图、群名、路径或凭据。

开发验证使用 `python3 -m unittest discover -s 此目录 -p test_stream.py`，覆盖去重、恢复、持久消费、权限、发送防重复及桥安装。Swift 的 self-test 仅校验程序可启动，不触碰真实窗口。
