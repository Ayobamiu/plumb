import type { ClaimKind } from "@plumb/core";

export const KIND_ORDER: ClaimKind[] = [
  "goal",
  "decision",
  "status",
  "next_step",
  "open_question",
  "fact",
];

export function kindLabel(kind: ClaimKind): string {
  return kind.replace(/_/g, " ");
}
