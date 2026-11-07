"""Exercise a bridge in our own synthetic host, never in WeChat.

Accepts no arguments or target PIDs. Run in a network-none, read-only container
as UID 1000 with an empty /work tmpfs. All native functions below are fixtures.
"""
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import time

LIBRARY = r'''
#define _GNU_SOURCE
#include <pthread.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>
static pthread_mutex_t lock=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed=PTHREAD_COND_INITIALIZER;
static pthread_t worker,main_thread;
static int running=1,ready=0,pending=0,finished=0,server=-1,started=0;
static unsigned current_id=0,calls=0,seen=0,thread_ok=1;
static const char *endpoint="/work/groupdesk-native-fixture.sock";
struct Reply {unsigned status,calls,main_thread;};
void fixture_enter_main(void){pthread_mutex_lock(&lock);main_thread=pthread_self();ready=1;pthread_mutex_unlock(&lock);}
int fixture_tick(void){
 pthread_mutex_lock(&lock);
 if(pending){if(!pthread_equal(main_thread,pthread_self()))thread_ok=0;seen|=1u<<current_id;++calls;pending=0;finished=1;pthread_cond_broadcast(&changed);}
 int value=running;pthread_mutex_unlock(&lock);return value;
}
static int exact(int fd,void *p,size_t n,int writing){
 char *at=p;while(n){ssize_t got=writing?write(fd,at,n):read(fd,at,n);if(got<=0)return 0;at+=got;n-=(size_t)got;}return 1;
}
static void *serve(void *unused){
 (void)unused;server=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0);
 if(server<0)return NULL;
 struct sockaddr_un a={0};a.sun_family=AF_UNIX;strcpy(a.sun_path,endpoint);
 if(bind(server,(struct sockaddr*)&a,sizeof(a))||chmod(endpoint,0600)||listen(server,4))return NULL;
 for(;;){
  int client=accept4(server,NULL,NULL,SOCK_CLOEXEC);if(client<0)break;
  struct ucred peer; socklen_t size=sizeof(peer);unsigned req[2];
  if(getsockopt(client,SOL_SOCKET,SO_PEERCRED,&peer,&size)||peer.uid!=getuid()||!exact(client,req,sizeof(req),0)){close(client);continue;}
  pthread_mutex_lock(&lock);unsigned status=0;
  if(req[0]==1){
   if(!ready||req[1]>=32)status=3;
   else if(seen&(1u<<req[1]))status=1;
   else {current_id=req[1];pending=1;finished=0;while(!finished&&running)pthread_cond_wait(&changed,&lock);}
  }else if(req[0]==3){running=0;pthread_cond_broadcast(&changed);}
  else if(req[0]!=2)status=2;
  struct Reply reply={status,calls,thread_ok};int keep=running;
  pthread_mutex_unlock(&lock);exact(client,&reply,sizeof(reply),1);close(client);if(!keep)break;
 }
 close(server);server=-1;unlink(endpoint);return NULL;
}
__attribute__((constructor)) static void start(void){started=pthread_create(&worker,NULL,serve,NULL)==0;}
__attribute__((destructor)) static void stop(void){
 pthread_mutex_lock(&lock);running=0;pthread_cond_broadcast(&changed);pthread_mutex_unlock(&lock);
 if(server>=0)shutdown(server,SHUT_RDWR);if(started)pthread_join(worker,NULL);unlink(endpoint);
}
'''

HOST = r'''
#include <dlfcn.h>
#include <stdlib.h>
#include <unistd.h>
int main(void){
 void *handle=NULL;
 if(getenv("FIXTURE_DLOPEN")){handle=dlopen("/work/fixture.so",RTLD_NOW|RTLD_LOCAL);if(!handle)return 4;}
 void (*enter)(void)=dlsym(handle?handle:RTLD_DEFAULT,"fixture_enter_main");
 int (*tick)(void)=dlsym(handle?handle:RTLD_DEFAULT,"fixture_tick");
 if(!enter||!tick)return 2;enter();while(tick())usleep(1000);
 if(handle)dlclose(handle);return 0;
}
'''


def run():
    if len(sys.argv) != 1 or sys.platform != 'linux' or os.getuid() != 1000:
        raise RuntimeError('Use zero arguments in an isolated Linux UID1000 container')
    root = Path('/work')
    if any(root.iterdir()):
        raise RuntimeError('Use an empty /work tmpfs')
    os.environ['TMPDIR'] = str(root)
    os.chdir(root)
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('Fixture deadline')))
    signal.alarm(40)
    for name, source in [('fixture.c', LIBRARY), ('host.c', HOST)]:
        (root/name).write_text(source)
    for args in [
        ['gcc', '-std=c11', '-O1', '-shared', '-fPIC', '-pthread', '/work/fixture.c', '-o', '/work/fixture.so'],
        ['gcc', '-std=gnu11', '-O1', '/work/host.c', '-ldl', '-o', '/work/host'],
    ]:
        built = subprocess.run(args, capture_output=True, text=True, timeout=15)
        if built.returncode:
            raise RuntimeError('Fixture compile failed: ' + built.stderr[:500])
    env = dict(os.environ)
    env.pop('LD_PRELOAD', None)
    env.pop('FIXTURE_DLOPEN', None)
    baseline = subprocess.run(['/work/host'], env=env, capture_output=True, timeout=5)
    if baseline.returncode != 2:
        raise AssertionError('Baseline unexpectedly loaded a fixture')
    results = {'baseline_without_library_rejected': True}
    endpoint = root/'groupdesk-native-fixture.sock'
    for mode in ['preload', 'dlopen']:
        active_env = dict(env)
        active_env['LD_PRELOAD' if mode == 'preload' else 'FIXTURE_DLOPEN'] = '/work/fixture.so' if mode == 'preload' else '1'
        proc = subprocess.Popen(['/work/host'], env=active_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not endpoint.exists():
                if proc.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('Fixture host did not create its endpoint')
                time.sleep(.01)
            def request(op, identity=0):
                with socket.socket(socket.AF_UNIX) as client:
                    client.settimeout(3)
                    client.connect(str(endpoint))
                    client.sendall(struct.pack('=II', op, identity))
                    value = b''
                    while len(value) < 12:
                        part = client.recv(12-len(value))
                        if not part:
                            raise RuntimeError('Incomplete fixture response')
                        value += part
                    return struct.unpack('=III', value)
            assert request(1, 7) == (0, 1, 1)
            assert request(1, 7) == (1, 1, 1)
            assert request(1, 8) == (0, 2, 1)
            assert request(1, 99) == (3, 2, 1)
            assert request(99) == (2, 2, 1)
            assert endpoint.stat().st_mode & 0o777 == 0o600
            assert request(2) == (0, 2, 1)
            assert request(3) == (0, 2, 1)
            stdout, stderr = proc.communicate(timeout=5)
            assert proc.returncode == 0 and not stdout and not stderr and not endpoint.exists()
            results[mode] = {'same_uid_unix_socket': True, 'socket_mode_0600': True, 'main_thread_callback': True, 'duplicate_not_executed': True, 'invalid_request_rejected': True, 'clean_exit_and_socket_cleanup': True}
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate(timeout=5)
    signal.alarm(0)
    return {'scope': 'own_synthetic_host_only', 'results': results, 'real_wechat_injection': False, 'native_send_verified': False, 'messages_sent': 0}


if __name__ == '__main__':
    print(json.dumps(run(), sort_keys=True))
