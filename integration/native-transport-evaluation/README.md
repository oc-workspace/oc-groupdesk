# Linux 微信原生发送评估工具

本目录只包含针对自建测试子进程的Linux调试原语实验，不包含微信注入器或消息发送器。评估结论和候选来源见[评估说明](../../docs/linux-native-transport-evaluation.md)。

`probe_synthetic.py`只接受零参数，内部fork一个UID1000的测试子进程；子进程自己请求跟踪，父进程只读取并修改这个子进程的已知测试缓冲区，再由子进程核验结果。没有目标PID、地址、微信进程发现、取钥、网络或发送接口。10秒超时清理自己的子进程；不增加SYS_PTRACE、不改变Yama或seccomp。

在已经审核的本机微信镜像中复现，替换`<源码绝对路径>`；不要挂载账号目录、桌面凭据、聊天记录、Docker socket或宿主PID空间：

```bash
docker run --rm --network none --read-only --user 1000:1000 \
  --pids-limit 32 --memory 128m --entrypoint python3 \
  -v <源码绝对路径>/integration/native-transport-evaluation:/probe:ro \
  sha256:d438de562ac84a81491c0f7a42f33d8592adf9b722609846f8e631f54f18ff16 \
  /probe/probe_synthetic.py
```

退出码0表示自建子进程实验全部通过，2表示至少一项能力受限，1表示实验环境或执行错误。通过仅证明这些系统调用对该测试子进程可用，不能证明真实微信可调试、函数地址和ABI正确、内部发送可用或实际消息送达。真实组件必须另外有Linux平台/确切微信版本、公开源码或可审核构建、静态指纹、错误处理与独立回执证据。
