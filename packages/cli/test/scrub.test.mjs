import { test } from "node:test";
import assert from "node:assert/strict";
import { scrub } from "../lib/scrub.mjs";

test("strips secret values but keeps names and normal text", () => {
  const input = [
    "META_MODEL_API_KEY=abc123def456ghi789",
    'SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJlLXZhbHVl"',
    "token sk-ant-api03-AAAABBBBCCCCDDDDEEEE and ghp_abcdefghijklmnopqrstuvwxyz0123",
    "Authorization: Bearer 0123456789abcdef0123456789abcdef",
    "postgres://plumb:hunter2pass@db.example.com:5432/x",
    "AKIAABCDEFGHIJKLMNOP",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    "plumb_Q2hhbmdlTWVQbGVhc2VUaGlzSXNBVG9rZW4",
    "The gym plan is push pull legs; commit 7377a37 fixed the model id.",
  ].join("\n");
  const out = scrub(input);
  for (const leaked of ["abc123def456", "eyJhbGci", "sk-ant-api03", "ghp_abc", "0123456789abcdef0123", "hunter2pass", "AKIAABCD", "MIIEow", "plumb_Q2hh"]) {
    assert.ok(!out.includes(leaked), `leaked ${leaked}:\n${out}`);
  }
  assert.ok(out.includes("META_MODEL_API_KEY=[REDACTED]"));
  assert.ok(out.includes("The gym plan is push pull legs; commit 7377a37 fixed the model id."));
});
