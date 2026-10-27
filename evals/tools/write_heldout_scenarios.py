# One-off writer for the 10 held-out scenarios (h01 to h10). Do not run these
# until the final evaluation (day 9), and do not tune prompts against them.
import json, os

D = os.path.join(os.path.dirname(__file__), "..", "scenarios")

def until(at): return {"type": "until", "at": at}
def dep(k): return {"type": "depends_on", "claim": k}
def absent(since, kind="email_received", **pattern): return {"type": "absence", "since": since, "pattern": {"event_kind": kind, **pattern}}
def claim(k, text, kind, valid_from, reasons): return {"temp_id": k, "text": text, "kind": kind, "valid_from": valid_from, "reasons": reasons}
def email(key, at, frm, thread, summary, kind="email_received"):
    e = {"key": key, "kind": kind, "occurred_at": at, "thread_id": thread, "summary": summary}
    if frm: e["from"] = frm
    return e
def clock(key, at): return {"key": key, "kind": "clock", "occurred_at": at, "summary": "tick"}
def text(key, at, kind, ext, title, body): return {"key": key, "at": at, "source": {"kind": kind, "external_id": ext, "title": title}, "text": body}
def cp(after, status=None, chain=None): return {"after": after, "status": status or {}, "chain": chain or []}

S = []

S.append(("reply-chain", {
  "id": "h01", "split": "heldout", "recorded_at": "2026-10-27T09:00:00Z",
  "title": "Kenji writes about something else first (no change), then replies in the spec thread: the claim and its reminder go OUT.",
  "claims": [
    claim("no_reply", "No reply from Kenji at Orbit about the integration spec.", "status", "2026-10-27T09:00:00Z",
          [absent("2026-10-27T09:00:00Z", **{"from": "kenji@orbit.dev", "thread_id": "t-spec-21"})]),
    claim("remind", "Remind Kenji about the spec on Monday.", "next_step", "2026-10-27T09:00:00Z", [dep("no_reply")]),
  ],
  "events": [
    email("kenji_other", "2026-10-28T10:00:00Z", "Kenji Sato <kenji@orbit.dev>", "t-orbit-hr", "Holiday schedule for November"),
    email("kenji_spec", "2026-10-29T11:00:00Z", "Kenji Sato <kenji@orbit.dev>", "t-spec-21", "Re: Integration spec: looks good, two small comments inline"),
  ],
  "expected": [cp("kenji_other"), cp("kenji_spec", {"no_reply": "OUT", "remind": "OUT"}, ["remind"])],
}))

S.append(("i-answered", {
  "id": "h02", "split": "heldout", "recorded_at": "2026-10-27T09:00:00Z",
  "title": "'I need to answer Fatima's invoice question' survives her follow-up email and goes OUT only when Usman sends the answer.",
  "claims": [
    claim("must_answer", "I need to answer Fatima's question about invoice #204.", "next_step", "2026-10-27T09:00:00Z",
          [absent("2026-10-27T09:00:00Z", kind="email_sent", thread_id="t-inv-204")]),
  ],
  "events": [
    email("fatima_followup", "2026-10-28T09:00:00Z", "Fatima Rahman <fatima@ledgerly.co>", "t-inv-204", "Re: Invoice #204: any update?"),
    email("usman_answers", "2026-10-28T12:00:00Z", None, "t-inv-204", "Re: Invoice #204: paid on Oct 20, receipt attached", kind="email_sent"),
  ],
  "expected": [cp("fatima_followup"), cp("usman_answers", {"must_answer": "OUT"})],
}))

S.append(("hold-expires", {
  "id": "h03", "split": "heldout", "recorded_at": "2026-10-28T09:00:00Z",
  "title": "A held appointment slot expires Nov 2 at 5 PM ET (EST after the clocks change); the claim and the plan to confirm go OUT only after.",
  "claims": [
    claim("slot_held", "The visa appointment slot is held until Nov 2 at 5 PM ET.", "status", "2026-10-28T09:00:00Z", [until("2026-11-02T22:00:00Z")]),
    claim("confirm", "Confirm the visa appointment before the hold ends.", "next_step", "2026-10-28T09:00:00Z", [dep("slot_held")]),
  ],
  "events": [clock("tick_before", "2026-11-02T21:59:00Z"), clock("tick_after", "2026-11-02T22:01:00Z")],
  "expected": [cp("tick_before"), cp("tick_after", {"slot_held": "OUT", "confirm": "OUT"}, ["confirm"])],
}))

S.append(("new-thread-signed", {
  "id": "h04", "split": "heldout", "recorded_at": "2026-10-27T12:00:00Z",
  "title": "Grace answers in a brand new thread: the pattern misses, the model check sends the claim to REVIEW.",
  "claims": [
    claim("no_reply", "No reply from Grace Mensah about the partnership terms.", "status", "2026-10-27T12:00:00Z",
          [absent("2026-10-27T12:00:00Z", **{"from": "grace@tidewater.org", "thread_id": "t-terms-9"})]),
  ],
  "events": [
    email("grace_new", "2026-10-29T14:00:00Z", "Grace Mensah <grace@tidewater.org>", "t-terms-10", "Partnership terms: signed copy attached, we're good to go"),
  ],
  "expected": [cp("grace_new", {"no_reply": "REVIEW"})],
}))

S.append(("forwarded-permit", {
  "id": "h05", "split": "heldout", "recorded_at": "2026-10-26T12:00:00Z",
  "title": "A colleague forwards the city's permit approval: different sender and thread, so the model check sends 'waiting on the permit' to REVIEW.",
  "claims": [
    claim("permit_pending", "Still waiting for the city's decision on the event permit.", "status", "2026-10-26T12:00:00Z",
          [absent("2026-10-26T12:00:00Z", **{"from": "permits@cityofbrook.gov", "thread_id": "t-permit-3"})]),
  ],
  "events": [
    email("fwd", "2026-10-29T09:00:00Z", "Theo Grant <theo@ourteam.io>", "t-fwd-77", "Fwd: Event permit: your event permit application has been approved"),
  ],
  "expected": [cp("fwd", {"permit_pending": "REVIEW"})],
}))

S.append(("no-false-alarm", {
  "id": "h06", "split": "heldout", "recorded_at": "2026-10-27T09:00:00Z",
  "title": "Omar writes about lunch in a new thread: nothing about the contractor, so the claim stays IN with no REVIEW.",
  "claims": [
    claim("no_reply", "No reply from Omar about hiring the contractor.", "status", "2026-10-27T09:00:00Z",
          [absent("2026-10-27T09:00:00Z", **{"from": "omar@buildright.io", "thread_id": "t-hire-4"})]),
  ],
  "events": [email("omar_lunch", "2026-10-28T12:00:00Z", "Omar Haddad <omar@buildright.io>", "t-lunch-2", "Team lunch Thursday? I'll book the usual place")],
  "expected": [cp("omar_lunch")],
}))

S.append(("e2e-waiting-reply", {
  "id": "h07", "split": "heldout", "recorded_at": "2026-10-27T17:00:00Z",
  "title": "End to end: a session note waits on Ines for the data export and plans a ping Monday; her reply in the known thread knocks down both.",
  "events": [
    email("ines_ack", "2026-10-26T10:00:00Z", "Ines Duarte <ines@vela.health>", "t-export-6", "Data export: request received, I'll run it this week"),
    email("ines_done", "2026-10-29T15:00:00Z", "Ines Duarte <ines@vela.health>", "t-export-6", "Re: Data export: done, the files are in the shared bucket"),
  ],
  "texts": [
    text("session", "2026-10-27T17:00:00Z", "cursor", "cur-7", "Cursor session",
         "Blocked on the dashboard until Ines at Vela sends the data export she promised. If there's nothing by Monday I'll ping her. Meanwhile I'll stub the charts with fake data."),
  ],
  "find": {"waiting_ines": ["ines"], "ping": ["ping"], "stub": ["stub"]},
  "expected": [cp("session"), cp("ines_done", {"waiting_ines": "OUT", "ping": "OUT"}, ["ping"])],
}))

S.append(("cross-tool-staging", {
  "id": "h08", "split": "heldout", "recorded_at": "2026-10-27T11:00:00Z",
  "title": "Cross-tool: Cursor says staging is deployed and working; a later Claude Code session says staging is down after a failed migration. The first claim goes to REVIEW.",
  "texts": [
    text("cursor_note", "2026-10-27T11:00:00Z", "cursor", "cur-8", "Cursor session", "Staging is deployed and working; the new dashboard loads in under a second."),
    text("cc_note", "2026-10-27T16:00:00Z", "claude_code", "cc-9", "Claude Code session",
         "Staging has been down since the 2 PM database migration failed halfway. Rolling back now."),
  ],
  "find": {"staging_ok": ["staging", "work"], "staging_down": ["down"]},
  "expected": [cp("cursor_note"), cp("cc_note", {"staging_ok": "REVIEW"})],
}))

S.append(("noise-agent-turn", {
  "id": "h09", "split": "heldout", "recorded_at": "2026-10-28T20:00:00Z",
  "title": "Noise: an agent turn with bookkeeping (lint counts, file paths, a PR number) around one decision and one next step. Measures extra claims; all stay IN.",
  "texts": [
    text("agent_turn", "2026-10-28T20:00:00Z", "cursor", "cur-9", "Cursor turn",
         "Ran lint: 0 errors, 3 warnings in apps/web/components/Feed.tsx. Opened PR #41 and pushed 4 commits. Updated the README table.\n\nDecision: the feed polls every 5 seconds instead of using realtime.\nNext: Claude Code adds an index on transitions.at."),
  ],
  "events": [email("unrelated", "2026-10-29T08:00:00Z", "billing@example.com", "t-bill-1", "Your October invoice")],
  "find": {"polling": ["poll"], "index_next": ["index"]},
  "expected": [cp("agent_turn"), cp("unrelated")],
}))

S.append(("confirm-then-restore", {
  "id": "h10", "split": "heldout", "recorded_at": "2026-10-27T09:00:00Z",
  "title": "Usman confirms a claim OUT (its follow-up falls too), then changes his mind and restores it: both come back IN.",
  "claims": [
    claim("no_reply", "No reply from Nadia about the venue contract.", "status", "2026-10-27T09:00:00Z",
          [absent("2026-10-27T09:00:00Z", **{"from": "nadia@harborhall.com", "thread_id": "t-venue-12"})]),
    claim("follow_up", "Follow up with Nadia on Wednesday.", "next_step", "2026-10-27T09:00:00Z", [dep("no_reply")]),
  ],
  "events": [email("unrelated", "2026-10-28T08:00:00Z", "news@example.com", "t-news-9", "Weekly digest")],
  "actions": [
    {"key": "confirm", "at": "2026-10-28T10:00:00Z", "action": "confirm_out", "claim": "no_reply"},
    {"key": "restore", "at": "2026-10-28T11:00:00Z", "action": "restore_in", "claim": "no_reply"},
  ],
  "expected": [
    cp("unrelated"),
    cp("confirm", {"no_reply": "OUT", "follow_up": "OUT"}, ["follow_up"]),
    cp("restore", {"no_reply": "IN", "follow_up": "IN"}),
  ],
}))

for name, s in S:
    ordered = {k: s[k] for k in ["id", "title", "split", "recorded_at", "claims", "texts", "find", "events", "actions", "expected"] if k in s}
    with open(os.path.join(D, f"{s['id']}-{name}.json"), "w") as f:
        json.dump(ordered, f, indent=2)
        f.write("\n")
print(len(S), "written")
