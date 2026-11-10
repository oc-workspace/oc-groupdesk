# 模型配置与按群路由

本页统一说明服务协议、模型目录、按群路由和分阶段选择；Key归属、申请与费用统一见[Key治理](api-key-governance.md)。

模型配置模块管理 OpenAI Chat Completions、OpenAI Responses 和 Gemini 原生 HTTPS 服务。OpenAI 两种使用 Bearer，Gemini 使用 x-goog-api-key，密钥不进入目录查询 URL。API Key 以 AES-256-GCM 密文存入数据库；独立的 MODEL_ENCRYPTION_KEY 保存在生产外部 env，列表与下拉框只返回名称和末6位；仅Key所有人可通过独立眼睛开关查看完整Key，管理员无例外。API 地址变化必须重新输入 Key，目录请求不跟随重定向，解析公网地址后固定连接地址并验证 TLS。

每个 Key 查询 /models，目录只作为服务列出的候选。若服务不提供功能元数据，按名称推测文字/生图/其他/待确认，不能据此保证权限、余额或实际调用成功。管理员可手动登记模型及文字/生图类型。查询失败保留原目录；查询成功也保留此前手动登记/现用模型，不擅自切换路由。本次查询不调用文字生成或图片生成接口。

默认模型按文字和生图设置。每个群按功能选择继承默认、本群单独选择或停用；切换 Key 时清空模型选择，服务端检查模型属于该 Key 且功能匹配。默认设置、Key 轮换/停用会增加受影响群 revision；老表单保存被拒绝。生图本次只保存选择，不启用群内生成或发图。

机器人 config 接口仅包含路由元数据，不含模型密钥。已授权适配器按group_id/revision取得短期代理凭据，私有0600快照仅缓存75秒租约，不再下发服务商Key。新模型路由必须由支持 model_routing_version=1 的机器人确认，旧客户端不能假确认。密钥停用、租约过期、版本变化或不匹配时拒绝，不回退其他 Key。

MaiBot 使用请求级 ModelInfo/APIProvider，不修改共享任务配置。原有任务槽名用于内部配额结算，实际 model_identifier 和 provider 用于真实请求；文字路由覆盖当前群规划/回复等获准的文字任务。全局预算、任务输出上限、来源绑定、发送前版本检查和 Persona 继续有效。install-model-routing.py 在已确认的 1.3.18 / GT v4 生产文件副本上检查并生成补丁，不直接覆盖源文件。测试镜像无网络、不挂载真实账本，不产生模型调用或微信群发送。

首次导入只在服务器间通过 SSH 标准输入传递既有 Key，运行 scripts/import-model-credential.ts；不写入 Git、日志或本机临时文件。保留既有文字模型为 configured 来源。外部加密主密钥必须与数据库备份一起恢复，保持文件 0600、目录仅 root 可访问；切勿仅恢复数据库后生成新的主密钥。

每日备份在root专用备份目录中保存model-encryption.env并纳入SHA256SUMS；恢复前核对外部主密钥，避免启动无法解密的数据库。目录/文件维持0700/0600，不将该文件上传Git或公开。

## 连接协议与配置模板

client_type 明确保存为 openai、openai_responses 或 gemini。Gemini 目录使用根地址+/v1beta/models（已有版本路径不重复追加），规范化 models/ 前缀并处理受限分页；OpenAI Responses 兼容标准 data 目录及 Codex 的 models/slug 目录。公开接口仅返回协议元数据，私有路由中的协议必须匹配。

Codex 模板中的 base_url、OPENAI_API_KEY、model、wire_api=responses 映射为项目凭据、配置参考模型及 openai_responses，不写本机 Codex config/auth，也不复制 goals/network_access 等客户端开关。Responses 原生客户端固定 store=false。Gemini 模板的根URL/Key/模型映射为 gemini；模型名含 image/banana 才推测为生图，普通 gemini-2.0-flash 与 gpt-5.5 仍归文字。目录未列出的模板模型保留为配置参考，不代表权限已验证。

协议更新递增凭据与受影响群版本，旧页面省略协议字段时保留原协议。脚本 scripts/import-model-providers.ts 仅从 stdin 读取批量配置，事务内重命名/加密新增/登记参考模型；重试不覆盖已有配置或默认路由，冲突整体回滚。

接口参考：[OpenAI Responses](https://developers.openai.com/api/reference/responses/overview)、[Gemini Models](https://ai.google.dev/api/models)、[Gemini Authentication](https://ai.google.dev/api)。第三方服务可用目录以实际查询为准。


## 新群接入配置助手

默认模型新增独立onboarding选择，首次按当前机器人已登记的maibot-gpt / gpt-5.5初始化；找不到时保持未配置，不替换其他Key或聊天模型。可在站点更改，也可在向导本次选用其他文字模型。仅改变助手不会使群配置待确认；群文字/阶段模型继续各自设置。AI辅助只生成待人工采纳的配置建议，授权和真实群绑定由接入程序完成。详见[站点接入向导](group-onboarding-wizard.md)。

## 多用户 Key 治理

归属、私有/站点公用、申请审批、分配、额度和代理计量见 [API Key 治理](api-key-governance.md)。旧的运行端原始密钥快照改为75秒代理凭据，不再下发服务商Key；未配置模型不回退旧Key。

## 分阶段模型与 API Key

在「模型与 API Key → 默认处理阶段模型」维护全局选择，在「群管理 → 本群模型与 API Key → 各处理阶段」覆盖单个群。每个阶段均选择一条已登记的 Key 和该 Key 下的模型；Key 自带 API 地址与接口协议，因此不同阶段也可以使用不同提供商。

| 阶段 | 实际用途 |
| --- | --- |
| 内容分析与规划 | MaiBot Planner，理解内容、决定回复方向及工具调用；所选模型需要支持工具调用。 |
| 回答生成 | MaiBot Replyer，生成普通回复或长文；继续使用本群 Persona 和语言规则。 |
| 快速辅助判断 | MaiBot `fast_model` 按需调用的辅助任务。 |
| 信息提取与整理 | MaiBot `utils` 按需调用的归纳等辅助文字任务。 |

微信消息读取、数据库查询、来源昵称/时间核对、基础消息类型识别、权限判断及发送由程序处理，不需要选择模型。此功能按已有任务分配模型，不强制每条消息依次调用五个模型，也不新增语义分类器、完整历史读取或图片识别能力。已有「生图」选择与图片内容理解不同，仍按原有说明使用。

解析基础消息类型后，是否需要辅助模型由既有 MaiBot 流程决定。仅选择 `utils` 不代表每条消息都会先运行信息提取。切换 Planner 可改善工具调用表现，但不能保证模型永远不生成非法参数；既有参数校验和受限容错继续生效。

### 继承与应用

优先级为「本群阶段单独选择 → 全局阶段单独选择 → 本群文字基础模型 → 全局文字基础模型 → 未配置则停止调用」。本群停用文字会停用所有文字阶段，不允许阶段覆盖绕过停用。

全部阶段默认继承，发布功能不会改变现有群的实际模型或 Key。取消阶段单独选择即可恢复继承。旧界面没有发送 `stages` 时，后台保留已有阶段配置；清空配置需由新界面明确保存。

当 Planner 和 Replyer 的实际模型、Key 或凭据版本不同，派发器会关闭该任务的快速直出与问候精简路径，避免 Planner 的一句 `reply_text` 绕过指定的回答模型。此时问候也会走 Planner 加 Replyer，可能比同一模型的快捷路径多一次调用。所有请求仍共享原有单任务、token、频率、超时、权限和送达防重约束。

保存配置后，在群管理点击「刷新确认状态」。存在阶段单独选择时，旧适配器不能确认；新适配器必须读取并验证当前群、当前 revision 的实际私有路由后，才能回传阶段能力确认。确认加载成功不等于已验证提供商权限、余额或某个模型的工具调用质量。

### 数据与凭据

阶段选择保存在已有 `model_settings.routes.stages` 和 `groups.model_routes.stages` JSON 字段，沿用原数据库备份，不需要新数据库表。更改全局阶段会更新实际继承它的群 revision；更换、停用或轮换阶段使用的 Key 也会使相关群旧配置失效。

公开配置只含 Key ID、名称、模型、协议及凭据版本，不含明文 Key。原 AES-256-GCM 存储、HTTPS 和适配器授权继续适用。当前运行端通过按群及revision受限的接口取得原生四阶段的短期代理凭据，写入权限`600`的私有快照，服务商原始Key留在服务端。总结 Key 留在 GroupDesk 服务端，不发给无此用途的 MaiBot。路由缺失、版本不符或凭据不匹配时拒绝该调用，不回退到别的群或默认 Key。

### 维护与验证

后台和网页实现位于 `server/models.ts`、`server/models-api.ts`、`web/model-editors.tsx`；阶段目录位于 `shared/model-stages.ts`。原生接入位于 `integration/maibot/model_routing.py`、`groupdesk_runtime.py`。对当前生产 Policy 的检查式补丁为 `install-stage-routing.py`，重复执行保持相同结果，未知派发基线拒绝修改。

初次阶段功能验收记录（非当前总测试数）：覆盖网页构建、87 项后台单元测试、87 项独立 PostgreSQL 集成测试和255项断网 MaiBot 原生测试；其中包含真实原生模型选择器传递不同 Key，以及问候派发不绕过独立回答模型的回归。测试使用合成消息和 Key，未向生产群发送测试消息。

## 群聊总结的单一配置入口

群总结的API Key和模型只在“群聊总结 → 总结API与高级选项”选择。群管理和默认阶段编辑器不再提供群总结选项；总结不会继承或跟随群内聊天模型。新群未配置时不能生成总结，启用发布前也必须完成选择。

036迁移将已有继承配置按原优先级冻结成总结自己的Key/模型：本群旧总结阶段 → 机器人旧默认总结阶段 → 本群文字 → 机器人默认文字；原群文字停用时保持总结不可用。总结页原单独选择优先保留。036迁移保留现有设置版本、任务快照、计划及原始群/默认JSON；037随后仅删除退役summary项，其他群和默认配置保留。新旧页面保存时均丢弃退役项，实际总结路由不读取该项。旧排队任务的inherit标记只读取迁移后的总结设置。
