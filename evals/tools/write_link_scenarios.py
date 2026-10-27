# One-off writer for link-suggestion scenarios: dev s23 and held-out h13
# (held-out: don't run until day 9, don't tune prompts against it).
import json, os

D = os.path.join(os.path.dirname(__file__), "..", "scenarios")

def until(at): return {"type": "until", "at": at}
def absent(since, frm): return {"type": "absence", "since": since, "pattern": {"event_kind": "email_received", "from": frm}}
def claim(k, text, kind, valid_from, reasons): return {"temp_id": k, "text": text, "kind": kind, "valid_from": valid_from, "reasons": reasons}
def email(key, at, frm, thread, summary): return {"key": key, "kind": "email_received", "occurred_at": at, "from": frm, "thread_id": thread, "summary": summary}
def cp(after, status=None, chain=None): return {"after": after, "status": status or {}, "chain": chain or []}

S = [
  ("cross-tool-link", {
    "id": "s23", "split": "dev", "recorded_at": "2026-10-27T12:00:00Z",
    "title": "Cross-tool chain needs a link nobody wrote: Claude Code says tests pass, Cursor plans the Friday deploy. The sweep should suggest 'deploy rests on tests' (and nothing for the blog post or the office). Once Usman accepts it, a CI failure knocks down both.",
    "claims": [
      claim("tests", "All tests pass on main.", "status", "2026-10-26T12:00:00Z", [absent("2026-10-26T12:00:00Z", "ci@builds.ourteam.io")]),
      claim("deploy", "Deploy the release to production on Friday.", "next_step", "2026-10-27T10:00:00Z", [until("2026-10-31T04:00:00Z")]),
      claim("blog", "Write the launch blog post this week.", "next_step", "2026-10-27T10:00:00Z", [until("2026-11-01T04:00:00Z")]),
      claim("office", "The office is closed on Monday for the holiday.", "fact", "2026-10-27T10:00:00Z", [until("2026-11-03T05:00:00Z")]),
    ],
    "events": [email("ci_fail", "2026-10-28T09:00:00Z", "CI <ci@builds.ourteam.io>", "t-ci-482", "Build #482 failed on main: 3 tests failing")],
    "actions": [{"key": "accept", "at": "2026-10-27T19:00:00Z", "action": "accept_links"}],
    "sweeps": [{"key": "sweep", "at": "2026-10-27T18:00:00Z"}],
    "expect_links": [["deploy", "tests"]],
    "expected": [cp("sweep"), cp("accept"), cp("ci_fail", {"tests": "OUT", "deploy": "OUT"}, ["deploy"])],
  }),
  ("cross-tool-link", {
    "id": "h13", "split": "heldout", "recorded_at": "2026-10-28T12:00:00Z",
    "title": "Cross-tool chain needs a link (held-out): the plan to announce the partnership rests on Tidewater still being on track to sign. Once accepted, Tidewater legal's email knocks down both. Flights and booth size are not links.",
    "claims": [
      claim("on_track", "Tidewater is still on track to sign the partnership agreement.", "status", "2026-10-27T12:00:00Z", [absent("2026-10-27T12:00:00Z", "legal@tidewater.org")]),
      claim("announce", "Announce the Tidewater partnership on stage at the Nov 12 conference.", "next_step", "2026-10-28T09:00:00Z", [until("2026-11-13T05:00:00Z")]),
      claim("flights", "Book flights to the Nov 12 conference.", "next_step", "2026-10-28T09:00:00Z", [until("2026-11-05T05:00:00Z")]),
      claim("booth", "Our conference booth is 3 by 3 meters.", "fact", "2026-10-28T09:00:00Z", [until("2026-11-13T05:00:00Z")]),
    ],
    "events": [email("legal", "2026-10-30T15:00:00Z", "Tidewater Legal <legal@tidewater.org>", "t-tw-legal", "Partnership agreement: we can't sign in its current form")],
    "actions": [{"key": "accept", "at": "2026-10-29T13:00:00Z", "action": "accept_links"}],
    "sweeps": [{"key": "sweep", "at": "2026-10-29T12:00:00Z"}],
    "expect_links": [["announce", "on_track"]],
    "expected": [cp("sweep"), cp("accept"), cp("legal", {"on_track": "OUT", "announce": "OUT"}, ["announce"])],
  }),
]

for name, s in S:
    ordered = {k: s[k] for k in ["id", "title", "split", "recorded_at", "claims", "texts", "find", "events", "actions", "sweeps", "expect_links", "expected"] if k in s}
    with open(os.path.join(D, f"{s['id']}-{name}.json"), "w") as f:
        json.dump(ordered, f, indent=2)
        f.write("\n")
print(len(S), "written")
