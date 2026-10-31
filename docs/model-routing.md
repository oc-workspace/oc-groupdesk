# 模型配置与按群路由

模型配置模块管理 OpenAI Chat Completions、OpenAI Responses 和 Gemini 原生 HTTPS 服务。OpenAI 两种使用 Bearer，Gemini 使用 x-goog-api-key，密钥不进入目录查询 URL。API Key 以 AES-256-GCM 密文存入数据库；独立的 MODEL_ENCRYPTION_KEY 保存在生产外部 env，网页只返回名称和末四位，编辑时不回显旧密钥。API 地址变化必须重新输入 Key，目录请求不跟随重定向，解析公网地址后固定连接地址并验证 TLS。

每个 Key 查询 /models，目录只作为服务列出的候选。若服务不提供功能元数据，按名称推测文字/生图/其他/待确认，不能据此保证权限、余额或实际调用成功。管理员可手动登记模型及文字/生图类型。查询失败保留原目录；查询成功也保留此前手动登记/现用模型，不擅自切换路由。本次查询不调用文字生成或图片生成接口。

默认模型按文字和生图设置。每个群按功能选择继承默认、本群单独选择或停用；切换 Key 时清空模型选择，服务端检查模型属于该 Key 且功能匹配。默认设置、Key 轮换/停用会增加受影响群 revision；老表单保存被拒绝。生图本次只保存选择，不启用群内生成或发图。

机器人 config 接口仅包含路由元数据，不含模型密钥。已授权的适配器按 group_id/revision 取本群有效文字 Key，并在私有 0600 快照中缓存到既有 75 秒租约。新模型路由必须由支持 model_routing_version=1 的机器人确认，旧客户端不能假确认。密钥停用、租约过期、版本变化或不匹配时拒绝，不回退其他 Key。

MaiBot 使用请求级 ModelInfo/APIProvider，不修改共享任务配置。原有任务槽名用于内部配额结算，实际 model_identifier 和 provider 用于真实请求；文字路由覆盖当前群规划/回复等获准的文字任务。全局预算、任务输出上限、来源绑定、发送前版本检查和 Persona 继续有效。install-model-routing.py 在已确认的 1.3.18 / GT v4 生产文件副本上检查并生成补丁，不直接覆盖源文件。测试镜像无网络、不挂载真实账本，不产生模型调用或微信群发送。

首次导入只在服务器间通过 SSH 标准输入传递既有 Key，运行 scripts/import-model-credential.ts；不写入 Git、日志或本机临时文件。保留既有文字模型为 configured 来源。外部加密主密钥必须与数据库备份一起恢复，保持文件 0600、目录仅 root 可访问；切勿仅恢复数据库后生成新的主密钥。

每日备份在root专用备份目录中保存model-encryption.env并纳入SHA256SUMS；恢复前核对外部主密钥，避免启动无法解密的数据库。目录/文件维持0700/0600，不将该文件上传Git或公开。

## 连接协议与配置模板

client_type 明确保存为 openai、openai_responses 或 gemini。Gemini 目录使用根地址+/v1beta/models（已有版本路径不重复追加），规范化 models/ 前缀并处理受限分页；OpenAI Responses 兼容标准 data 目录及 Codex 的 models/slug 目录。公开接口仅返回协议元数据，私有路由中的协议必须匹配。

Codex 模板中的 base_url、OPENAI_API_KEY、model、wire_api=responses 映射为项目凭据、配置参考模型及 openai_responses，不写本机 Codex config/auth，也不复制 goals/network_access 等客户端开关。Responses 原生客户端固定 store=false。Gemini 模板的根URL/Key/模型映射为 gemini；模型名含 image/banana 才推测为生图，普通 gemini-2.0-flash 与 gpt-5.5 仍归文字。目录未列出的模板模型保留为配置参考，不代表权限已验证。

协议更新递增凭据与受影响群版本，旧页面省略协议字段时保留原协议。脚本 scripts/import-model-providers.ts 仅从 stdin 读取批量配置，事务内重命名/加密新增/登记参考模型；重试不覆盖已有配置或默认路由，冲突整体回滚。

接口参考：[OpenAI Responses](https://developers.openai.com/api/reference/responses/overview)、[Gemini Models](https://ai.google.dev/api/models)、[Gemini Authentication](https://ai.google.dev/api)。第三方服务可用目录以实际查询为准。
