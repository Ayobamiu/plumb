# One-off writer for relevance scenarios (Usman's party/shoes case): dev s24,
# held-out h14 (don't run until day 9, don't tune prompts against it).
import json, os

D = os.path.join(os.path.dirname(__file__), "..", "scenarios")

def text(key, at, kind, ext, title, body): return {"key": key, "at": at, "source": {"kind": kind, "external_id": ext, "title": title}, "text": body}
def clock(key, at): return {"key": key, "kind": "clock", "occurred_at": at, "summary": "tick"}
def cp(after, status=None): return {"after": after, "status": status or {}, "chain": []}

S = [
  ("party-shoes", {
    "id": "s24", "split": "dev", "recorded_at": "2026-10-28T14:00:00Z",
    "title": "Relevance: the shoe choice and the table booking only matter until Dana's dinner (Sat Oct 31, 7 PM ET). After it, both go OUT on the clock; the lasting fact about Dana's favorite restaurant stays IN.",
    "texts": [
      text("chat", "2026-10-28T14:00:00Z", "claude_chat", "chat-9", "Claude chat",
           "For Dana's birthday dinner this Saturday, Oct 31 at 7 PM, I still need to pick between the red or the white shoes. I also need to book a table for 8 at Luca before then. Good to remember: Luca is Dana's favorite restaurant."),
    ],
    "find": {"shoes": ["shoe"], "table": ["table"], "luca_fact": ["favorite"]},
    "events": [clock("saturday_afternoon", "2026-10-31T20:00:00Z"), clock("sunday_morning", "2026-11-01T15:00:00Z")],
    "expected": [cp("chat"), cp("saturday_afternoon"), cp("sunday_morning", {"shoes": "OUT", "table": "OUT"})],
  }),
  ("wedding-suit", {
    "id": "h14", "split": "heldout", "recorded_at": "2026-10-29T13:00:00Z",
    "title": "Relevance (held-out): choosing the suit and sending the RSVP only matter until their moments pass (RSVP by Mon Nov 2, wedding Sat Nov 7). The fact about the venue stays IN.",
    "texts": [
      text("note", "2026-10-29T13:00:00Z", "cursor", "cur-12", "Cursor session",
           "Personal note before I forget: Sam and Lee's wedding is Saturday, Nov 7. I have to send the RSVP by Monday, Nov 2, and I still haven't decided between the navy or the grey suit. The venue is the Old Mill in Hudson."),
    ],
    "find": {"rsvp": ["rsvp"], "suit": ["suit"], "venue": ["mill"]},
    "events": [clock("tue_nov3", "2026-11-03T15:00:00Z"), clock("fri_nov6", "2026-11-06T15:00:00Z"), clock("sun_nov8", "2026-11-08T15:00:00Z")],
    "expected": [cp("note"), cp("tue_nov3", {"rsvp": "OUT"}), cp("fri_nov6"), cp("sun_nov8", {"suit": "OUT"})],
  }),
]
for name, s in S:
    ordered = {k: s[k] for k in ["id", "title", "split", "recorded_at", "claims", "texts", "find", "events", "actions", "sweeps", "expect_links", "expected"] if k in s}
    with open(os.path.join(D, f"{s['id']}-{name}.json"), "w") as f:
        json.dump(ordered, f, indent=2)
        f.write("\n")
print(len(S), "written")
