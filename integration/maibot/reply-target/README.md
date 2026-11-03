# Bounded reply argument recovery

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

## Structured reference compatibility (2026-11-03)

At 13:23 Singapore time, a normally admitted mention failed before Replyer:
Planner supplied `reply_reference` as an object containing `message_id` and
`reply_direction`, although the native tool requires a nonempty string. It then
selected `stop` instead of repairing the arguments. The model calls completed;
this was neither a login failure nor a long-running provider request.

`normalize_reference` accepts only that exact two-key object shape. Its nested
message ID must equal the current, live, same-group source proved by `resolve`;
any supplied top-level target must also agree. The direction must be a nonempty,
bounded string. Only then is it converted to `reply_reference`, with `msg_id`
set to the verified source. Valid string references remain untouched. Unknown
objects, extra options, mismatched IDs, stale turns and invalid group leases
retain the existing refusal behavior. The function does not stringify arbitrary
JSON or redirect to a recent message.

The installer adds this normalization before native reference validation and
preserves the original target repair. Replyer selection, the actual Persona,
language, output limits, permission and quota checks, and verified-delivery
deduplication still run normally. A non-fast request is not upgraded to a fast
send merely because Planner included `reply_text`. No extra model call is added.

The regression fixture recreates this argument shape with synthetic data and
mocked sends, checks exactly one native guarded send, and checks rejection of
unverified targets. The full fixture needs the existing read-only persona and
bowxt SDK resources; it runs with Docker networking disabled. Production group
tests are prohibited. Any operator-approved backfill separately verifies that
the old turn cannot send, links the source to a unique send ID, and confirms
delivery through the existing bridge.

Validation: all 216 current native `/limits` regressions passed without skips,
including the seven new reference-format cases. The first run exposed missing
persona/SDK mounts in the isolated fixture; adding those existing read-only
dependencies resolved the fixture errors without weakening assertions. The
installer produced identical bytes on its second run. No production model API
or real group was used for tests.
