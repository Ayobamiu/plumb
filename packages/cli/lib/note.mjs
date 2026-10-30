// The "what changed" note shown at session start (Oct 29).
const MAX_NOTE_LINES = 5;

/** At most 5 lines from get_project_state's changed_since; "" when nothing changed. */
export function changeNote(changed) {
  if (!changed.length) return "";
  const lines = changed.slice(0, MAX_NOTE_LINES).map(({ claim, transition, source_title }) => {
    const label = transition.to_status === "OUT" ? "No longer true" : "May be out of date";
    const where = source_title ? ` (in "${source_title}")` : "";
    return `- ${label}${where}: ${claim.text.replace(/[.!?]?$/, ".")} ${transition.explanation}`;
  });
  const more = changed.length > MAX_NOTE_LINES ? `\n(${changed.length - MAX_NOTE_LINES} more: ask with /plumb)` : "";
  return `Plumb: since your last session in this folder, ${changed.length === 1 ? "this changed" : "these changed"}:\n${lines.join("\n")}${more}`;
}

