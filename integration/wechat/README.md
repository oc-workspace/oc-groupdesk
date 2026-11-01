# 相同文字的新消息身份

Linux微信的Qt行标识不是原生消息ID。旧采集器由文字、时间、可见重复序号计算标识，并在时间分隔线消失时合并同文记录；一条新消息与旧消息同文、时间不可见且重复序号重置时，可能复用旧行及旧发言人缓存，导致另一成员的签到未独立入库。

`frame_identity.py`在视觉发言人缓存之前，用每群连续画面的有序重叠识别追加行，为每条可确认的新行分配独立`arrival:`标识。该标识贯穿发言人补全、入库和Agent投递；追加行不经过旧的同文/缺时间合并。重复轮询和重启沿用持久化画面与已知邻接关系，时间标签消失或回看后返回不生成新事件。本表只存哈希、标识、时间与有限邻接记录，不复制聊天正文。

第一次启用追踪时，新的初始可见行只记为`historical`，不触发Agent和积分；已入库的当前行保持原状态。后来回看时新暴露的历史前缀也不发给Agent。确认的追加行可绕过旧的全文引用误过滤，旧历史引用保护保留；本机发送回执与追加行的UI回显仍合并为同一次发送。

这是可见界面的连续性修复，不是微信服务端ID接入。画面完全失去重叠、只剩无法区分的重复内容等情况仍退回原有读取能力，不能承诺不可见历史完整覆盖。娱乐积分继续按群昵称记账，改名和同名仍需人工核对。未改GroupDesk的每天次数、奖励、模型、配额或发送去重。

## 验证和发布

1. 用`baseline.json`校验`client.py`、`service.py`、`store.py`三个已部署文件的摘要，再在隔离SDK副本运行`install-frame-identity.py SDK_ROOT baseline.json`。重复执行应字节一致；未知基线拒绝安装。
2. 将`test_frame_identity.py`放入SDK的tests目录。用固定响应性镜像`sha256:d4fdddc24109a4220bc497149ea16f80cef11891139b0dc25492500ac87a90f6`断网运行完整测试；不挂载生产/config。再用该SDK挂载运行原生MaiBot回归。
3. 测试通过后生成validation.json，记录baseline、candidate四文件SHA256、构建脚本SHA256、sdk_tests=153及native_tests=280。按既定oc-push→oc-prod-release→PR精确候选审查流程发布本目录。
4. 从相同已测SDK根目录用本目录Dockerfile构建`wechat-bot:frame-identities-PROD_SHA前12位`，传入完整SOURCE_REVISION。构建前确认本机基镜像摘要与第2步一致。该镜像只包含代码，不含聊天库或凭据。
5. 生产root2运行`deploy-root2.py --stage SDK_ROOT --manifest validation.json --release PROD_SHA --check`。通过后去掉--check。脚本比较运行与主机基线、已测源码、镜像内源码和版本标签，等待空闲，短暂关闭桥接入站，只停止`custom-svc-bowxt`。
6. 根用户私有目录备份源码、原开关、构建脚本、私有.env以及三份SQLite，更新与新镜像一致的四文件，仅重启采集API，不重启微信、MaiBot或桥接。更新WECHAT_IMAGE供今后正常重建使用；把有摘要门控的安装调用加入既有SDK构建脚本，防止未来构建遗漏补丁。比较微信容器StartedAt及原微信进程启动标识，恢复原开关。

成功证据保存在root2的`install-artifacts/frame-identity-时间/result.json`和持久目录`bowxt-release.json`。异常自动回退源文件和构建/镜像配置，仅重启采集API；新表为附加状态，不回灌旧SQLite覆盖新消息。备份含私有.env与聊天数据，保持root-only，不能提交仓库或拷贝到客户端。

验收只做断网合成消息和运行摘要/健康检查，不向真实群发送测试消息，不补发历史签到、不人工伪造采集时间或补积分。
