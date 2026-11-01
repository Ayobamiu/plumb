import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, loadState, saveState, sha256, stateKey } from "../src/state.js";

describe("sync state", () => {
  it("starts empty when the file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "local-sync-"));
    expect(loadState(join(dir, "missing.json"))).toEqual(emptyState());
  });

  it("round-trips through save and load", () => {
    const dir = mkdtempSync(join(tmpdir(), "local-sync-"));
    const path = join(dir, "nested", "state.json");
    saveState(path, {
      version: 1,
      sessions: { [stateKey("cursor", "abc")]: { hash: sha256("x"), sentAt: "2026-10-28T00:00:00Z", mode: "index" } },
    });
    expect(loadState(path).sessions["cursor:abc"]!.mode).toBe("index");
  });

  it("refuses a corrupt file instead of resending everything", () => {
    const dir = mkdtempSync(join(tmpdir(), "local-sync-"));
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({ version: 2 }), "utf8");
    expect(() => loadState(path)).toThrow(/bad sync state/);
  });
});
