# Missing reply target recovery

The 2026-11-01 20:29 (Singapore) mention was received and admitted normally.
Planner called `reply` without the required `msg_id`; the tool rejected it.
The next Planner call selected `stop`, leaving no visible delivery. This was
neither a WeChat disconnect nor a long-running model timeout.

`reply_target.py` repairs only a missing/null/blank `msg_id`. It derives the
target from the existing `TURN` context and the live admitted turn, then finds
that exact transport message in the current session. Platform, transport turn,
group metadata, current GroupDesk lease and revision must agree. Supplied IDs
are never redirected. Absent, stale, cross-group or unbound tasks retain their
existing failure behavior. No arbitrary most-recent-message fallback is used.

The native `reply` tool then continues through its existing target resolution,
Replyer/fast-reply eligibility, Persona, send quota and delivery deduplication.
The repair adds no model request and changes no model/time/token/group limits.

Install alongside the existing pinned-image overrides:

1. Copy `reply_target.py` to the existing `/limits` mount.
2. Run `python install.py PATH_TO_EXISTING_PATCHED_REPLY_PY`.
3. In an isolated pinned MaiBot image, mount the patched native reply and
   current runtime helpers, and run `test_reply_target.py` plus existing tests.
4. Back up the current native override, wait for admitted work to finish,
   pause bridge collection/sending, and recreate only MaiBot with the new
   override. Restore the exact previous bridge controls after health checks.
5. Retain this installer after the existing override generation steps for
   future rebuilds; running it twice leaves the file unchanged.

Tests use synthetic messages and mocked sends with Docker networking disabled.
Do not send test messages to production groups. A separately authorized manual
catch-up must be linked to its original source and verified delivery to prevent
future recovery from sending it twice.

Validation: 9 targeted cases passed, followed by all 178 current `/limits`
regressions in the pinned image, with Docker networking disabled and no skips.
The first broad run lacked the bridge source in its test mount; after adding
that existing source to the fixture, both bridge tests and the full suite passed.
Only the native reply override and this helper were deployed. WeChat and bridge
containers were not restarted; model routing, time budgets and quotas unchanged.
