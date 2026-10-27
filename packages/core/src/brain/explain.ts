// One-sentence explanations for transitions. Templates in code, never the LLM.
import type { AbsencePattern, Claim, ClaimStatus, Event } from "../contract.js";

const TZ = process.env.PLUMB_TZ ?? "America/New_York";

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

export function explainAbsenceBroken(pattern: AbsencePattern, event: Event): string {
  const when = formatTime(event.occurred_at);
  const thread = event.thread_id ? ` in thread ${event.thread_id}` : "";
  switch (event.kind) {
    case "email_received":
      return `Went OUT because an email from ${event.from ?? "the sender"} arrived${thread} at ${when}.`;
    case "email_sent":
      return `Went OUT because you sent an email${thread} at ${when}.`;
    case "doc_edited":
      return `Went OUT because the doc was edited at ${when}: ${event.summary}`;
    case "session_note":
      return `Went OUT because a session note at ${when} said: ${event.summary}`;
    case "clock":
      return `Went OUT because a ${pattern.event_kind} event happened at ${when}.`;
  }
}

export function explainUntilPassed(at: string): string {
  return `Went OUT because its time limit passed at ${formatTime(at)}.`;
}

export function explainChain(cause: Claim): string {
  return `Went OUT because it depends on "${cause.text}", which went OUT.`;
}

export function explainRestored(cause?: Claim): string {
  return cause
    ? `Back IN because "${cause.text}" was restored and its other reasons still hold.`
    : "Back IN because Usman marked it as still true.";
}

export function explainEdited(oldText: string, from: ClaimStatus): string {
  return from === "IN"
    ? `Usman edited it; it used to say "${oldText}".`
    : `Back IN because Usman edited it; it used to say "${oldText}".`;
}

/** Fold Usman's note into the explanation, keeping it one sentence. */
export function withNote(explanation: string, note: string): string {
  return `${explanation.replace(/\.$/, "")} (note: ${note}).`;
}

/** Part C: the model thinks an event may break the claim. Usman decides. */
function eventPhrase(event: Event): string {
  const what =
    event.kind === "email_received"
      ? `an email from ${event.from ?? "someone"}`
      : event.kind === "email_sent"
        ? "an email you sent"
        : event.kind === "doc_edited"
          ? "a doc edit"
          : "a note";
  return `${what} at ${formatTime(event.occurred_at)}`;
}

const judgedAs = (verdict: "yes" | "unsure") =>
  verdict === "yes" ? "says this is no longer true" : "can't tell if this still holds";

const unquote = (quote: string) => quote.replace(/[.!?]+$/, "");

export function explainModelCheck(event: Event, verdict: "yes" | "unsure", quote: string): string {
  return `Sent to REVIEW because a model check of ${eventPhrase(event)} ${judgedAs(verdict)}: "${unquote(quote)}".`;
}

/** Sleep-time sweep: a slower re-read of recent events caught what the quick check missed. */
export function explainSweep(event: Event, verdict: "yes" | "unsure", quote: string): string {
  return `Sent to REVIEW because the background check of ${eventPhrase(event)} ${judgedAs(verdict)}: "${unquote(quote)}".`;
}

export const DUPLICATE_PREFIX = "Sent to REVIEW because it looks like a repeat of";

/** Sleep-time sweep: this claim says the same as an older one. Confirm OUT keeps just the older. */
export function explainDuplicate(kept: Claim): string {
  return `${DUPLICATE_PREFIX} "${unquote(kept.text)}"; confirm OUT to keep just one.`;
}

/** A model read new text and thinks it contradicts the claim. Usman decides. */
export function explainContradicted(sourceTitle: string, quote: string): string {
  return `Sent to REVIEW because ${sourceTitle} said: "${quote.replace(/[.!?]+$/, "")}".`;
}

export function explainConfirmedOut(): string {
  return "Went OUT because Usman confirmed it is no longer true.";
}
