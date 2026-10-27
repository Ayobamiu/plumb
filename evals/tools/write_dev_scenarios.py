# One-off writer for dev scenarios s07, s08, s10, s13 to s20. Kept so the
# scenario text is reviewable in one place; the JSON files are the source of truth.
import json, os

D = os.path.join(os.path.dirname(__file__), "..", "scenarios")

def until(at): return {"type": "until", "at": at}
def dep(k): return {"type": "depends_on", "claim": k}
def absent(since, **pattern): return {"type": "absence", "since": since, "pattern": {"event_kind": "email_received", **pattern}}
def claim(k, text, kind, valid_from, reasons): return {"temp_id": k, "text": text, "kind": kind, "valid_from": valid_from, "reasons": reasons}
def email(key, at, frm, thread, summary, kind="email_received"):
    e = {"key": key, "kind": kind, "occurred_at": at, "thread_id": thread, "summary": summary}
    if frm: e["from"] = frm
    return e
def clock(key, at): return {"key": key, "kind": "clock", "occurred_at": at, "summary": "tick"}
def text(key, at, kind, ext, title, body): return {"key": key, "at": at, "source": {"kind": kind, "external_id": ext, "title": title}, "text": body}
def cp(after, status=None, chain=None): return {"after": after, "status": status or {}, "chain": chain or []}

S = []

S.append({
  "id": "s07", "split": "dev", "recorded_at": "2026-10-25T14:00:00Z",
  "title": "Doc edit removes a decision: the updated doc contradicts the hosting decision and the deploy plan, both go to REVIEW. The unrelated open question stays IN.",
  "texts": [
    text("doc_v1", "2026-10-25T14:00:00Z", "doc", "doc-launch", "Launch plan",
         "Launch plan\n\nDecision: we host the API on Railway.\nNext step: Dana deploys the API to Railway on Friday, Oct 30.\nOpen question: do we need a separate staging environment?"),
    text("doc_v2", "2026-10-27T10:00:00Z", "doc", "doc-launch", "Launch plan",
         "Launch plan (updated Oct 27)\n\nDecision: after Sunday's outage we moved hosting from Railway to Fly.io.\nNext step: Dana deploys the API to Fly.io on Friday, Oct 30.\nOpen question: do we need a separate staging environment?"),
  ],
  "find": {"host_railway": ["host", "railway"], "deploy_railway": ["dana", "railway"], "staging": ["staging"]},
  "expected": [cp("doc_v1"), cp("doc_v2", {"host_railway": "REVIEW", "deploy_railway": "REVIEW"})],
})

S.append({
  "id": "s08", "split": "dev", "recorded_at": "2026-10-26T15:00:00Z",
  "title": "Cross-tool: Claude Code says the tests pass and Cursor should wire the login page; a later Cursor session says the login page is merged and the build broke. Both go to REVIEW.",
  "texts": [
    text("cc_session", "2026-10-26T15:00:00Z", "claude_code", "cc-1", "Claude Code session",
         "Finished the auth middleware. All 48 tests pass on main.\nNext: Cursor wires the login page to the new middleware."),
    text("cursor_session", "2026-10-26T19:00:00Z", "cursor", "cur-1", "Cursor session",
         "Merged the login page into main. The build on main is broken now: 3 auth tests fail because AUTH_SECRET is missing in CI. I'll fix it tomorrow morning."),
  ],
  "find": {"tests_pass": ["tests", "pass"], "login_next": ["login"], "build_broken": ["build"]},
  "expected": [cp("cc_session"), cp("cursor_session", {"tests_pass": "REVIEW", "login_next": "REVIEW"})],
})

S.append({
  "id": "s10", "split": "dev", "recorded_at": "2026-10-25T10:00:00Z",
  "title": "Restore: an out-of-office auto-reply knocks down the claim and its follow-up; Usman restores it and both come back IN; the real reply later knocks both down again.",
  "claims": [
    claim("no_reply", "No reply from Jordan at Hallway about the demo day headcount.", "status", "2026-10-25T09:00:00Z",
          [absent("2026-10-25T09:00:00Z", **{"from": "jordan.kim@hallway.io", "thread_id": "t-venue-2"})]),
    claim("nudge", "Nudge Jordan about the headcount on Wednesday.", "next_step", "2026-10-25T09:00:00Z", [dep("no_reply")]),
  ],
  "events": [
    email("auto_reply", "2026-10-26T08:00:00Z", "Jordan Kim <jordan.kim@hallway.io>", "t-venue-2", "Automatic reply: Out of office until Oct 28"),
    email("real_reply", "2026-10-28T14:00:00Z", "jordan.kim@hallway.io", "t-venue-2", "Re: Demo day: 40 seats confirmed"),
  ],
  "actions": [{"key": "usman_restores", "at": "2026-10-26T09:00:00Z", "action": "restore_in", "claim": "no_reply"}],
  "expected": [
    cp("auto_reply", {"no_reply": "OUT", "nudge": "OUT"}, ["nudge"]),
    cp("usman_restores", {"no_reply": "IN", "nudge": "IN"}),
    cp("real_reply", {"no_reply": "OUT", "nudge": "OUT"}, ["nudge"]),
  ],
})

S.append({
  "id": "s13", "split": "dev", "recorded_at": "2026-10-25T16:00:00Z",
  "title": "End to end: a session note says we are waiting on Rosa and will check in Thursday; extraction finds her real thread; her reply knocks down both. The pricing prep stays IN.",
  "events": [
    email("rosa_ack", "2026-10-24T11:00:00Z", "Rosa Lima <rosa@kiln.studio>", "t-kiln-1", "Kiln pilot: proposal received, I'll review it with the team"),
    email("rosa_yes", "2026-10-27T13:00:00Z", "Rosa Lima <rosa@kiln.studio>", "t-kiln-1", "Re: Kiln pilot: we're in, let's start on Nov 10"),
  ],
  "texts": [
    text("session", "2026-10-25T16:00:00Z", "claude_code", "cc-2", "Claude Code session",
         "Still waiting on Rosa at Kiln Studio to get back to us on the pilot proposal; she said she'd go over it with her team. If I hear nothing by Thursday I'll send her a short check-in. Separately, I need to prep the pricing one-pager before the Kiln call."),
  ],
  "find": {"rosa_waiting": ["rosa"], "check_in": ["check"], "pricing": ["pricing"]},
  "expected": [cp("session"), cp("rosa_yes", {"rosa_waiting": "OUT", "check_in": "OUT"}, ["check_in"])],
})

S.append({
  "id": "s14", "split": "dev", "recorded_at": "2026-10-25T18:00:00Z",
  "title": "End to end: 'I owe Jordan a reply' goes OUT when Usman's own reply is sent in that thread. The headcount fact stays IN.",
  "events": [
    email("jordan_asks", "2026-10-25T15:00:00Z", "Jordan Kim <jordan.kim@hallway.io>", "t-venue-2", "Demo day venue: can you confirm your headcount by Wednesday?"),
    email("usman_replies", "2026-10-26T10:00:00Z", None, "t-venue-2", "Re: Demo day venue: we'll be 40 people", kind="email_sent"),
  ],
  "texts": [
    text("note", "2026-10-25T18:00:00Z", "claude_chat", "chat-1", "Claude chat",
         "Reminder for myself: I owe Jordan at Hallway a reply with our demo day headcount. We're planning for 40 people."),
  ],
  "find": {"owe_jordan": ["jordan"], "headcount": ["40"]},
  "expected": [cp("note"), cp("usman_replies", {"owe_jordan": "OUT"})],
})

S.append({
  "id": "s15", "split": "dev", "recorded_at": "2026-10-26T12:00:00Z",
  "title": "End to end deadline: early-bird pricing ends Oct 30 at noon ET; the claim and the plan to register before then go OUT on the first clock tick after noon, not before.",
  "texts": [
    text("notes", "2026-10-26T12:00:00Z", "doc", "doc-notes", "Notes",
         "Early-bird pricing for the AI Builders Summit ends Oct 30 at noon ET. We should register Priya and me before then."),
  ],
  "events": [clock("before_noon", "2026-10-30T15:30:00Z"), clock("after_noon", "2026-10-30T16:30:00Z")],
  "find": {"early_bird": ["early"], "register": ["register"]},
  "expected": [cp("notes"), cp("before_noon"), cp("after_noon", {"early_bird": "OUT", "register": "OUT"})],
})

S.append({
  "id": "s16", "split": "dev", "recorded_at": "2026-10-26T20:00:00Z",
  "title": "Noise: an agent turn full of bookkeeping (commit hash, test counts, doc revision) with one decision, one next step and one open question. Measures extra claims; all stay IN.",
  "texts": [
    text("agent_turn", "2026-10-26T20:00:00Z", "claude_code", "cc-3", "Claude Code turn",
         "Committed as 7f1fab5. Typecheck passes in all 5 packages, and 32 tests pass (15 core, 17 server). Progress log updated to revision 28. The evals are unchanged at 5/5 with 0 false retractions.\n\nDecision: extraction runs at reasoning effort medium.\nNext: Cursor exposes POST /ingest on the server.\nOpen question: should the SessionEnd hook send the whole transcript or a trimmed one?"),
  ],
  "events": [email("newsletter", "2026-10-27T08:00:00Z", "news@example.com", "t-news-1", "This week in AI tooling")],
  "find": {"effort": ["medium"], "ingest_next": ["ingest"], "transcript_q": ["transcript"]},
  "expected": [cp("agent_turn"), cp("newsletter")],
})

S.append({
  "id": "s17", "split": "dev", "recorded_at": "2026-10-26T12:00:00Z",
  "title": "Late-seen old email: Sam's message from before the claim was written arrives late and must not break it (neither code nor model check); his later reply does.",
  "claims": [
    claim("no_reply", "No reply from Sam about the revised quote.", "status", "2026-10-26T12:00:00Z",
          [absent("2026-10-26T12:00:00Z", **{"from": "sam.ortiz@fabworks.com", "thread_id": "t-quote-5"})]),
  ],
  "events": [
    email("old_email", "2026-10-26T09:00:00Z", "Sam Ortiz <sam.ortiz@fabworks.com>", "t-quote-5", "Re: Quote: revised quote coming later this week"),
    email("new_reply", "2026-10-27T15:00:00Z", "sam.ortiz@fabworks.com", "t-quote-5", "Re: Quote: revised quote attached"),
  ],
  "expected": [cp("old_email"), cp("new_reply", {"no_reply": "OUT"})],
})

S.append({
  "id": "s18", "split": "dev", "recorded_at": "2026-10-26T10:00:00Z",
  "title": "Two reasons: 'ship the beta Friday' holds while Lee hasn't flagged the design AND until Friday ends; Friday passing takes it and its dependent OUT while the design claim stays IN; Lee's email later takes the design claim OUT.",
  "claims": [
    claim("design_ok", "Lee hasn't flagged any problems with the beta design.", "status", "2026-10-26T10:00:00Z",
          [absent("2026-10-26T10:00:00Z", **{"from": "lee.park@studio.dev", "thread_id": "t-design-8"})]),
    claim("ship_friday", "Ship the beta on Friday, Oct 30.", "next_step", "2026-10-26T10:00:00Z",
          [dep("design_ok"), until("2026-10-31T04:00:00Z")]),
    claim("tweet", "Schedule the launch tweet for Friday.", "next_step", "2026-10-26T10:00:00Z", [dep("ship_friday")]),
  ],
  "events": [
    clock("friday_over", "2026-10-31T04:01:00Z"),
    email("lee_flags", "2026-11-01T12:00:00Z", "Lee Park <lee.park@studio.dev>", "t-design-8", "Re: Beta design: the onboarding flow breaks on mobile"),
  ],
  "expected": [
    cp("friday_over", {"ship_friday": "OUT", "tweet": "OUT"}, ["tweet"]),
    cp("lee_flags", {"design_ok": "OUT"}),
  ],
})

S.append({
  "id": "s19", "split": "dev", "recorded_at": "2026-10-25T12:00:00Z",
  "title": "Model check, no false alarm: a newsletter names Avery and Northfield's pilot; it says nothing about the LOI or the pilot start, so both claims stay IN with no REVIEW.",
  "claims": [
    claim("no_reply", "No reply from Avery Hart about the LOI yet.", "status", "2026-10-25T12:00:00Z",
          [absent("2026-10-25T12:00:00Z", **{"from": "avery.hart@northfield.edu", "thread_id": "t-loi-101"})]),
    claim("pilot_jan", "The Northfield pilot starts in January.", "fact", "2026-10-25T12:00:00Z",
          [absent("2026-10-25T12:00:00Z", text_hint="Northfield pilot start date moved")]),
  ],
  "events": [
    email("newsletter", "2026-10-27T07:00:00Z", "EdTech Weekly <news@edtechweekly.io>", "t-edw-44",
          "This week: Avery Hart of Northfield speaks at EdTech Summit about how districts run pilot programs."),
  ],
  "expected": [cp("newsletter")],
})

S.append({
  "id": "s20", "split": "dev", "recorded_at": "2026-10-26T09:00:00Z",
  "title": "Promise kept early: 'Matt will send the deck by Friday' is not broken by any pattern, but Matt's email with the deck on Wednesday sends it to REVIEW.",
  "claims": [
    claim("deck_by_friday", "Matt Okafor will send the final pitch deck by Friday.", "next_step", "2026-10-26T09:00:00Z",
          [until("2026-10-31T04:00:00Z")]),
  ],
  "events": [
    email("deck_sent", "2026-10-28T16:00:00Z", "Matt Okafor <matt@newco.io>", "t-deck-3", "Pitch deck: final version attached, ready for Friday"),
  ],
  "expected": [cp("deck_sent", {"deck_by_friday": "REVIEW"})],
})

for s in S:
    name = {"s07": "doc-edit-removes-decision", "s08": "cross-tool-build-broke", "s10": "restore", "s13": "e2e-waiting-reply",
            "s14": "e2e-reply-owed", "s15": "e2e-deadline", "s16": "noise-agent-turn", "s17": "late-old-email",
            "s18": "two-reasons", "s19": "check-no-false-alarm", "s20": "promise-kept-early"}[s["id"]]
    ordered = {k: s[k] for k in ["id", "title", "split", "recorded_at", "claims", "texts", "find", "events", "actions", "expected"] if k in s}
    with open(os.path.join(D, f"{s['id']}-{name}.json"), "w") as f:
        json.dump(ordered, f, indent=2)
        f.write("\n")
print(len(S), "written")
