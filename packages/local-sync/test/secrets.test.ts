import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/secrets.js";

describe("redactSecrets", () => {
  it("redacts PEM private keys", () => {
    const text = "key:\n-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----\ndone";
    expect(redactSecrets(text)).toBe("key:\n[redacted]\ndone");
  });

  it("redacts bearer tokens but keeps the scheme word", () => {
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop123")).toBe("Authorization: Bearer [redacted]");
  });

  it("redacts named secret values but keeps the name", () => {
    expect(redactSecrets("api_key=supersecretvalue")).toBe("api_key=[redacted]");
    expect(redactSecrets("password: hunter2hunter2")).toBe("password: [redacted]");
  });

  it("redacts known token prefixes", () => {
    expect(redactSecrets("use dte_abcdefgh1234 here")).toBe("use [redacted] here");
    expect(redactSecrets("key ghp_abcdefgh1234 end")).toBe("key [redacted] end");
  });

  it("leaves ordinary text alone", () => {
    const text = "Usman:\nReview the auth diff";
    expect(redactSecrets(text)).toBe(text);
  });
});
