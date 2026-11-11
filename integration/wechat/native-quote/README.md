# Native WeChat quote sender

`install.py SDK_ROOT` applies `native-quote.patch` only to the exact five-file Bowxt baseline recorded in `manifest.json`. It is idempotent and rejects a changed SDK. The patch adds a visible UI Quote action, a Bowxt queue/API method, and a read-only `probe_only` path that cancels the draft before Enter.

The bridge first verifies the target's native `server_id`, exact text and uniqueness through Chatlog Reader. After a Quote send, it accepts success only if Reader sees an outgoing type 49/text reply with `reference_server_id` equal to that target. An ambiguous, missing or unverified send is never replayed or represented as a native quote.

Tatsumi's real Linux WeChat UI passed non-sending Quote-menu probes on 2026-11-12 for both an incoming message and a previously sent long summary part in Shanghai. The probe found the visible bubble, matched the separate WeChat Quote menu window against the reviewed image, checked the native preview against the exact target, clicked **Delete quote**, and confirmed no draft remained. No group message was sent. The account remained connected with an empty send queue. The outbound send plus Reader reference verification still requires a controlled live test before enabling group commands.
