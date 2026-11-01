# 每小时可用性巡检

主程序、微信和桥接继续运行在原Docker容器内。宿主机已有Python/systemd执行轻量运维调度，不依赖Mac、Codex会话或大模型。timer每整点运行一次；发现故障后，仅在当轮进行有限恢复和短暂复查，不新增30秒周期巡检。消息采集和配置同步保持原频率。

## 状态与动作

- 健康但群内安静：保持安静，不发送测试消息、不调用模型。
- 管理员通过ops.py暂停：报告维护状态，不自动恢复收发。
- 明确的登录按钮：只在没有聊天编辑器、没有会话列表且登录窗口无歧义时点击一次。
- 手机确认、二维码或电脑锁定：停止自动尝试，通知既有Hermes Telegram私聊。
- 微信进程消失：保留/config，从已有桌面会话启动微信。
- 界面读取异常：先重启bowxt读取服务，不重启微信。
- MaiBot或桥接异常：仅重启对应容器，有有效活动任务时暂缓。容器已停止则通知，尊重Docker手动停止状态。
- 每小时最多两次恢复动作，单轮不会反复执行同一动作。

`desktop_control.py`部署至持久化的/config/bowxt/availability_desktop.py，以abc用户执行。只返回状态，不返回聊天正文或界面截图。不能代替手机验证，也不能保证微信会提供免确认登录能力。

## 通知与恢复后行为

告警通过接收方Ryuuna扫码绑定的Server酱Turbo微信通道发送，独立于小T的微信登录。管理员在GroupDesk系统设置保存SendKey并确认接收方已绑定；凭据加密保存，只向对应适配器下发。这里的微信号是接收方说明，不能代替接收方扫码绑定。未绑定时后台明确显示待配置，通知保留待重试，不改发Telegram。

首次健康检查不发通知；故障状态变化与恢复才通知，同一故障不每小时提醒。每天最多尝试成功提交5条，失败保留待重试状态。请求受理不等于接收方实际收到，可在后台发送验证通知核对。只发送技术状态，不发送群聊天正文。

故障恢复后，最多尝试向现有已授权群发送一条英文上线说明，按当前群启停、语言、版本和总量限制执行。使用稳定幂等ID；不要求群友重发，不自动补答未知历史。配额或语言不允许时跳过。常规巡检不向群发送消息。

GroupDesk使用专用适配器token接收/api/runtime/health，每群独立授权。健康报告不递增配置revision，不充当配置ACK。后台超过75分钟未收到报告则显示待确认；管理员点击现有刷新按钮更新页面。平台本身断网、整机关闭时，服务器内的检查器不能向外发送通知。

## Swap配置

当前实施目标为宿主机2GiB持久化swap；微信物理内存保持1664MiB，memory+swap总上限3712MiB。使用docker update在线应用，再同步Compose的memswap_limit，不重建当前微信容器。swap由宿主机内核提供，不是新安装的应用服务。

swap只是峰值缓冲，不能修复持续增长。保留每小时内存/swap采样；不关闭OOM保护，不把内存设为无限。恢复前备份fstab、Compose和原容器限制。回退时先停timer，保留正在使用的swap；只有确认宿主机有足够余量容纳换回内存后再swapoff，不能直接删除正在使用的文件。

## 安装与验收

把monitor.py放在服务器项目availability/，复制desktop_control.py到持久化目录。安装.service/.timer到/etc/systemd/system，daemon-reload后先手动执行一次service，确认状态上报，再enable --now timer。

monitor状态保存在/opt/persist/maibot-wechat/availability/state.json，权限0600。查看：systemctl status maibot-availability.timer、journalctl -u maibot-availability.service。停止巡检：systemctl disable --now maibot-availability.timer。日常维护仍使用原ops.py pause/resume。

测试：python3 -m unittest discover -s integration/maibot/availability -q。故障测试使用Fake驱动，不断开真实微信、不发送测试消息、不调用模型。实际登录点击只在真实故障出现时触发。
