# One-off writer for the sleep-time sweep scenarios: dev s21, s22 and held-out
# h11, h12 (held-out: don't run until day 9, don't tune prompts against them).
import json, os

D = os.path.join(os.path.dirname(__file__), "..", "scenarios")

def until(at): return {"type": "until", "at": at}
def hint(since, text_hint, kind="doc_edited"): return {"type": "absence", "since": since, "pattern": {"event_kind": kind, "text_hint": text_hint}}
def claim(k, text, kind, valid_from, reasons): return {"temp_id": k, "text": text, "kind": kind, "valid_from": valid_from, "reasons": reasons}
def email(key, at, frm, thread, summary): return {"key": key, "kind": "email_received", "occurred_at": at, "from": frm, "thread_id": thread, "summary": summary}
def cp(after, status=None): return {"after": after, "status": status or {}, "chain": []}

S = [
  ("sweep-recheck", {
    "id": "s21", "split": "dev", "recorded_at": "2026-10-25T12:00:00Z",
    "title": "Sweep re-check: a teammate says the database is moving to Neon. It shares no words with 'We use Supabase for storage', so the quick check never sees it; the sweep sends the decision to REVIEW. The venue fact stays IN.",
    "claims": [
      claim("storage", "We use Supabase for storage.", "decision", "2026-10-25T12:00:00Z", [hint("2026-10-25T12:00:00Z", "storage moved away from Supabase")]),
      claim("venue", "Demo day is at the Hallway space.", "fact", "2026-10-25T12:00:00Z", [hint("2026-10-25T12:00:00Z", "demo day venue changed", "email_received")]),
    ],
    "events": [email("theo_db", "2026-10-27T10:00:00Z", "Theo Grant <theo@ourteam.io>", "t-db-2", "Heads up: we're moving the database to Neon next week; the migration starts Monday.")],
    "sweeps": [{"key": "sweep", "at": "2026-10-27T15:00:00Z"}],
    "expected": [cp("theo_db"), cp("sweep", {"storage": "REVIEW"})],
  }),
  ("sweep-duplicates", {
    "id": "s22", "split": "dev", "recorded_at": "2026-10-25T12:00:00Z",
    "title": "Sweep duplicates: two claims say the demo is at Hallway; the newer one goes to REVIEW and the older is kept. The date and the contact are related but different, so they stay IN.",
    "claims": [
      claim("old_venue", "Demo day is at the Hallway space.", "fact", "2026-10-23T12:00:00Z", [until("2026-11-05T05:00:00Z")]),
      claim("date", "Demo day is on Nov 4.", "fact", "2026-10-24T12:00:00Z", [until("2026-11-05T05:00:00Z")]),
      claim("contact", "Our contact at Hallway is Jordan Kim.", "fact", "2026-10-24T12:00:00Z", [until("2026-11-05T05:00:00Z")]),
      claim("new_venue", "The demo day venue is Hallway.", "fact", "2026-10-25T12:00:00Z", [until("2026-11-05T05:00:00Z")]),
    ],
    "sweeps": [{"key": "sweep", "at": "2026-10-26T03:00:00Z"}],
    "expected": [cp("sweep", {"new_venue": "REVIEW"})],
  }),
  ("sweep-recheck", {
    "id": "h11", "split": "heldout", "recorded_at": "2026-10-26T12:00:00Z",
    "title": "Sweep re-check (held-out): finance says freelancer invoices move to Remote.com. It barely shares words with 'We pay contractors through Deel', so only the sweep catches it. The Studio Kite fact stays IN.",
    "claims": [
      claim("deel", "We pay contractors through Deel.", "decision", "2026-10-26T12:00:00Z", [hint("2026-10-26T12:00:00Z", "contractor payments moved off Deel")]),
      claim("kite", "The design contract with Studio Kite runs until March.", "fact", "2026-10-26T12:00:00Z", [hint("2026-10-26T12:00:00Z", "Studio Kite contract ended early", "email_received")]),
    ],
    "events": [email("finance", "2026-10-28T09:00:00Z", "Mira Shah <mira@ourteam.io>", "t-fin-3", "Starting December, all freelancer invoices go through Remote.com instead.")],
    "sweeps": [{"key": "sweep", "at": "2026-10-28T12:00:00Z"}],
    "expected": [cp("finance"), cp("sweep", {"deel": "REVIEW"})],
  }),
  ("sweep-duplicates", {
    "id": "h12", "split": "heldout", "recorded_at": "2026-10-28T12:00:00Z",
    "title": "Sweep duplicates (held-out): two claims give the Kiln pilot start date; the newer goes to REVIEW. The budget and the contact stay IN.",
    "claims": [
      claim("old_start", "The Kiln pilot starts on Nov 10.", "fact", "2026-10-27T12:00:00Z", [until("2026-12-31T05:00:00Z")]),
      claim("budget", "The Kiln pilot budget is $12,000.", "fact", "2026-10-27T13:00:00Z", [until("2026-12-31T05:00:00Z")]),
      claim("contact", "Rosa Lima is our contact at Kiln.", "fact", "2026-10-27T14:00:00Z", [until("2026-12-31T05:00:00Z")]),
      claim("new_start", "Our pilot with Kiln Studio begins November 10.", "fact", "2026-10-28T12:00:00Z", [until("2026-12-31T05:00:00Z")]),
    ],
    "sweeps": [{"key": "sweep", "at": "2026-10-29T03:00:00Z"}],
    "expected": [cp("sweep", {"new_start": "REVIEW"})],
  }),
]

for name, s in S:
    ordered = {k: s[k] for k in ["id", "title", "split", "recorded_at", "claims", "texts", "find", "events", "actions", "sweeps", "expected"] if k in s}
    with open(os.path.join(D, f"{s['id']}-{name}.json"), "w") as f:
        json.dump(ordered, f, indent=2)
        f.write("\n")
print(len(S), "written")
