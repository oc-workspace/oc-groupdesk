# 群间 GroupDesk

自托管的微信群机器人管理站点，按用户、机器人和群隔离话题、人设、模型、知识、互动与总结。GroupDesk控制面在rococo-root以Docker部署；微信、Reader与MaiBot运行端在rococo-root2。

React/Vite、TypeScript/Express、PostgreSQL控制库与机器人业务库，配套后台worker和互动worker。API Key仅所有人可查看完整值，其他人含站点管理员只见末6位。

- [项目总览、当前能力与待办规划](docs/README.md)：唯一功能导航及规划入口。
- [每日进度与发布证据](docs/progress/README.md)：按天保留测试、PR、部署和验收记录。
- [部署、备份、恢复与运行状态](docs/operations.md)：统一运维说明。

开发检查：`npm run build`、`npm test`；数据库集成检查只在专用隔离测试库运行。发布严格遵循[开发与生产发布脚本说明](https://github.com/oc-workspace/openclaw-workspace/blob/main/openclaw-开发与生产发布脚本说明.md)。密钥、Cookie和真实群聊不进入Git或日志。
