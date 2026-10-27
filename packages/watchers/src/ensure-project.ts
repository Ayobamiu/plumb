import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), "../../.env");
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const { data: existing, error: readErr } = await db
  .from("projects")
  .select("id,name")
  .eq("name", "Meta hackathon")
  .maybeSingle();
if (readErr) {
  console.error(readErr.message);
  process.exit(1);
}

let id = existing?.id;
if (!id) {
  id = randomUUID();
  const { error } = await db
    .from("projects")
    .insert({ id, name: "Meta hackathon", created_at: new Date().toISOString() });
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log("created", id);
} else {
  console.log("exists", id);
}

let text = readFileSync(envPath, "utf8");
if (!/^PLUMB_PROJECT_ID=/m.test(text)) {
  appendFileSync(envPath, `\nPLUMB_PROJECT_ID=${id}\n`);
  console.log("env_added PLUMB_PROJECT_ID");
} else {
  text = text.replace(/^PLUMB_PROJECT_ID=.*$/m, `PLUMB_PROJECT_ID=${id}`);
  writeFileSync(envPath, text.endsWith("\n") ? text : `${text}\n`);
  console.log("env_set PLUMB_PROJECT_ID");
}
