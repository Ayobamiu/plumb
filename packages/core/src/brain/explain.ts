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

/** A model read new text and thinks it contradicts the claim. Usman decides. */
export function explainContradicted(sourceTitle: string, quote: string): string {
  return `Sent to REVIEW because ${sourceTitle} said: "${quote.replace(/[.!?]+$/, "")}".`;
}

export function explainConfirmedOut(): string {
  return "Went OUT because Usman confirmed it is no longer true.";
}
