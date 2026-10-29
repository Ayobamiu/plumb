import { describe, expect, it } from "vitest";
import { computeCoverage, renderCoverage } from "../src/index.js";

const now = "2026-10-28T22:00:00Z";

describe("coverage", () => {
  it("shows per tool when it last saved, counts recent sessions, and flags a tool gone quiet", () => {
    const rows = computeCoverage(
      [
        { kind: "claude_code", source_id: "a", at: "2026-10-28T20:00:00Z" },
        { kind: "claude_code", source_id: "a", at: "2026-10-27T20:00:00Z" },
        { kind: "claude_code", source_id: "b", at: "2026-10-26T20:00:00Z" },
        { kind: "cursor", source_id: "c", at: "2026-10-25T20:00:00Z" }, // 3 days ago
        { kind: "doc", source_id: "d", at: "2026-10-10T20:00:00Z" }, // old, but docs never go stale
      ],
      now,
    );
    const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(by.claude_code).toMatchObject({ tool: "Claude Code", last_saved_at: "2026-10-28T20:00:00Z", sources_7d: 2, stale: false });
    expect(by.cursor).toMatchObject({ stale: true, sources_7d: 1 });
    expect(by.doc).toMatchObject({ stale: false, sources_7d: 0 });
    expect(by.muse_code).toEqual({ kind: "muse_code", tool: "Muse Code", sources_7d: 0, stale: false }); // never saved: not flagged

    const md = renderCoverage(rows, now).join("\n");
    expect(md).toContain("Not saved lately: Cursor (3 days).");
    expect(md).toContain("- Claude Code: last saved");
    expect(md).toContain(", 2 sessions in the last 7 days");
    expect(md).toContain("- Muse Code: nothing saved yet");
    expect(md).not.toContain("Notes");
  });
});
