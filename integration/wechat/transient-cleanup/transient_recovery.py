"""Bounded cleanup of SDK-owned avatar popovers; never unlock a failed client."""
import time
from .selectors import is_profile_card


def begin_profile(client, main, chat, known):
    client._profile_lease={'root':main.identity,'chat':chat,'started':time.monotonic(),
                           'known':set(known),'owned':set(),'recovery_attempted':False}


def _profile_surface(window,main):
    if 'modal' in window.states or window.role=='dialog':return False
    if is_profile_card(window):return True
    # Qt can expose an empty profile top-level before its contents arrive.
    # Only this specific avatar-created filler shape is eligible, never a
    # named dialog, call, media viewer, or window that existed before the click.
    b=window.bounds;r=main.bounds
    return bool(window.role=='filler' and not window.name.strip() and b and r
                and 180<=b.width<=520 and 80<=b.height<=r.height)


def observe_profile(client,main,windows):
    lease=getattr(client,'_profile_lease',None)
    if not lease or lease['root']!=main.identity:return
    for window in windows:
        if window.identity not in lease['known'] and _profile_surface(window,main):
            lease['owned'].add(window.identity)


def cleanup_owned_profile(client):
    """At most one extra Escape; old client stays locked and is discarded.

    Never replay a send. A clean new client must resolve and validate its own
    chat before later queued work can proceed.
    """
    lease=getattr(client,'_profile_lease',None)
    if not lease or lease['recovery_attempted'] or time.monotonic()-lease['started']>30:return False
    lease['recovery_attempted']=True
    main=client.accessibility.main_window()
    if main.identity!=lease['root']:return False
    if lease['chat'] and not (client._verified_controls(main,lease['chat']) or client._is_chat_open(main,lease['chat'])):return False
    extras=[w for w in client.accessibility.windows() if w.identity!=main.identity]
    if not extras:return True
    if not all(w.identity in lease['owned'] and _profile_surface(w,main) for w in extras):return False
    inputs=client._input
    active=getattr(inputs,'is_active_wechat_window',None);press=getattr(inputs,'shortcut_active_wechat',None)
    if not callable(active) or not callable(press) or not active():return False
    press('esc')
    for _ in range(20):
        if not any(w.identity!=main.identity for w in client.accessibility.windows()):
            return bool(client.accessibility.main_window().identity==lease['root'] and
                        (not lease['chat'] or client._is_chat_open(main,lease['chat'])))
        client._sleep(.05)
    return False


def sender_ready(service,key):
    item=service._sender_retries.get(key)
    return not item or (item[0]<3 and item[1]<=time.monotonic())


def sender_started(service,key):
    attempts=service._sender_retries.get(key,(0,0))[0]+1
    service._sender_retries[key]=(attempts,time.monotonic()+(2 if attempts==1 else 8))
    # Bounded, in-memory read retry state, not chat or nickname storage.
    while len(service._sender_retries)>512:
        service._sender_retries.pop(next(iter(service._sender_retries)))


def sender_finished(service,key):
    service._sender_retries.pop(key,None)
