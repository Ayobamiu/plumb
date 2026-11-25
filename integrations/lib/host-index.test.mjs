/**
 * node --test integrations/lib/host-index.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hostIndex, localIndex, indexExcerpt } from "./host-index.mjs";

describe("localIndex", () => {
  it("uses the native title and marks personal gym text", () => {
    const out = localIndex("User:\nplan my gym week for bad knees\n\nCursor:\nswaps listed", {
      title: "Knee-friendly week",
      sourceKind: "cursor",
    });
    assert.equal(out.title, "Knee-friendly week");
    assert.match(out.summary, /gym|knee/i);
    assert.equal(out.personal, true);
    assert.equal(out.indexed_by, "local/cursor/index.v1");
  });

  it("derives a title from the first User line", () => {
    const out = localIndex("User:\nship host session ingest\n\nClaude:\nok", {
      sourceKind: "claude_code",
    });
    assert.match(out.title, /host session ingest/i);
  });
});

describe("indexExcerpt", () => {
  it("keeps short text whole", () => {
    assert.equal(indexExcerpt("hello"), "hello");
  });
});

describe("hostIndex", () => {
  it("is local-only (no API)", async () => {
    const out = await hostIndex("User:\nfix gmail watcher\n\nCursor:\nlooking", {
      title: "Gmail tick",
      sourceKind: "cursor",
    });
    assert.equal(out.title, "Gmail tick");
    assert.equal(out.indexed_by, "local/cursor/index.v1");
  });
});
