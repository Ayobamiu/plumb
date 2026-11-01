// Shared shape for the three history readers. externalId must match what the
// tool's hooks send, so a session is never saved twice.
export type ToolName = "claude_code" | "cursor" | "muse_code";

export interface LocalSession {
  tool: ToolName;
  /** Same id the hooks use: Claude session id, Cursor conversation id, Muse session UUID. */
  externalId: string;
  file: string;
  /** The tool's own title when the history carries one. */
  title?: string;
  /** Working folder the session ran in, when the history carries one. */
  workdir?: string;
  /** Cursor project slug (encodes the workspace path); used for repo matching. */
  slug?: string;
}

export interface SessionText {
  turns: string[];
  title?: string;
  workdir?: string;
}

/** Plain labeled text from turns. Labels match the hooks: Usman plus the tool name. */
export function joinTurns(turns: string[]): string {
  return turns.join("\n\n").trim();
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const p = part as { type?: unknown; text?: unknown };
    if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
      parts.push(p.text.trim());
    }
  }
  return parts.join("\n").trim();
}
