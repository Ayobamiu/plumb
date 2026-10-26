// Live extraction check, no database: run Muse Spark on sample texts and
// print what passes the checks. Run from the repo root: pnpm smoke:extract
import { extractClaims, type ExtractInput } from "../brain/extract.js";
import { MetaClient } from "./client.js";

const now = new Date().toISOString();
const threads = [
  { thread_id: "t-loi-101", subject: "LOI for the Northfield pilot", participants: ["avery.hart@northfield.edu"] },
  { thread_id: "t-venue-7", subject: "Demo day venue", participants: ["events@hallway.io"] },
];
const samples: { name: string; input: Partial<ExtractInput> & { text: string } }[] = [
  {
    name: "session note: waiting, follow-up, reply owed",
    input: {
      text: `Wrapped up the invalidation engine today, scenarios 1 to 5 pass.
Still no answer from Avery Hart on the LOI for the Northfield pilot. If nothing by Friday I'll nudge her, and I should draft that nudge tonight.
I also owe the venue people (events@hallway.io) a reply about demo day seating.
Decided to keep Supabase for storage; not worth switching this week.
The hackathon submission is due Nov 4 at 9 PM ET.`,
    },
  },
  {
    name: "contradiction of a current claim",
    input: {
      text: "Ran the suite after Cursor's merge: three invalidation tests now fail on main. Looking into it tomorrow.",
      in_claims: [{ id: "claim-tests", text: "The invalidation engine passes all tests.", kind: "status" }],
    },
  },
];

const model = new MetaClient();
for (const s of samples) {
  const out = await extractClaims(model, {
    source: { kind: "claude_code", title: "Sample session" },
    at: now,
    now,
    in_claims: [],
    threads,
    ...s.input,
  });
  console.log(`\n=== ${s.name}`);
  for (const c of out.claims) {
    console.log(`- ${c.temp_id} [${c.kind}] ${c.text}${c.same_as ? ` (same_as ${c.same_as})` : ""}`);
    for (const r of c.reasons) console.log(`    ${JSON.stringify(r)}`);
  }
  if (out.contradicts.length) console.log("contradicts:", JSON.stringify(out.contradicts));
  if (out.dropped.length) console.log("dropped:", JSON.stringify(out.dropped));
}
