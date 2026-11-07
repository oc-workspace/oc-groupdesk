# Linux 微信原生发送评估工具

本目录包含自建测试进程上的Linux调试原语、桥接夹具和针对精确公开ELF的静态分析工具，不包含微信注入器或消息发送器。评估结论和候选来源见[评估说明](../../docs/linux-native-transport-evaluation.md)。

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

## 精确构建的静态发送线索

`analyze_wechat_send_anchors.py`只读取公开可执行文件。它核对锁定的SHA256、ELF架构、GNU Build ID和异常展开表，定位发送字符串引用，再用objdump检查指令边界与目标。未知指纹直接拒绝。默认只输出JSON；增加`--disassembly`可输出有限范围的公开代码反汇编，临时用于分析，不应把整个可执行文件或大段反汇编提交仓库。

工具不查找PID、不执行可执行文件、不访问进程内存、不获取密钥，也不包含发送接口。需要Python3和binutils；在固定镜像中运行：

```bash
docker run --rm --network none --read-only --user 1000:1000 \
  --pids-limit 32 --memory 256m --cpus 0.5 --entrypoint python3 \
  -v <公开ELF绝对路径>:/binary:ro \
  -v <源码绝对路径>/integration/native-transport-evaluation/analyze_wechat_send_anchors.py:/probe.py:ro \
  sha256:d438de562ac84a81491c0f7a42f33d8592adf9b722609846f8e631f54f18ff16 \
  /probe.py /binary
```

返回`native_send_verified: false`是范围声明，不能因找到引用而改为true。2026年11月7日的4组锚点、6处经objdump核验的引用，见[证据](../../docs/evidence/linux-native-transport-2026-11-07.json)。

## 动态库与通信夹具

`probe_native_loader_fixture.py`接受零参数，只编译并启动它自己的宿主与动态库。临时宿主经LD_PRELOAD或dlopen加载自建库，由同UID Unix Socket提交合成整数任务，再由宿主主线程执行。重复ID、非法请求和退出清理均有断言；没有微信路径、目标PID、函数偏移、联系人或消息正文。

```bash
docker run --rm --network none --read-only --user 1000:1000 \
  --pids-limit 32 --memory 256m --cpus 0.5 \
  --tmpfs /work:rw,exec,nosuid,nodev,size=32m,mode=1777 \
  --entrypoint python3 \
  -v <源码绝对路径>/integration/native-transport-evaluation/probe_native_loader_fixture.py:/probe.py:ro \
  sha256:d438de562ac84a81491c0f7a42f33d8592adf9b722609846f8e631f54f18ff16 \
  /probe.py
```

镜像需包含gcc。`/work`必须是空tmpfs；明确允许执行仅用于该容器内生成的两个夹具，容器退出即删除。不挂载真实账号或桌面。通过只证明自建库和宿主的加载、通信与调度，不证明微信内部调用或账号安全。

## 真实进程证据的边界

2026年11月7日的真实微信附加退出另有明确授权与目标核验，结果单独保存在证据中。该操作不属于以上零参数合成工具，也未在本目录加入任意目标注入、函数调用或发送程序。动态库的真实加载、微信内部函数调用和消息送达仍分别标为未验证。
