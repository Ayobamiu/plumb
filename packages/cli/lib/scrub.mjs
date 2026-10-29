// Strip secrets before any text leaves the machine. Past transcripts often hold
// API keys, tokens and .env contents. The names stay (they help a search), the
// values go. Better to cut a harmless long string than to send a real key.
const R = "[REDACTED]";

const PATTERNS = [
  // Private key blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, R],
  // NAME=value or NAME: value where the name says it's secret
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)[^\s"'`]{6,}\3/gi, `$1$2$3${R}$3`],
  // Known token shapes
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, R],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, R],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, R],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, R],
  [/\bplumb_[A-Za-z0-9_-]{20,}/g, R],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, R], // JWTs
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, `$1 ${R}`],
  // Passwords in URLs: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${R}@`],
];

export function scrub(text) {
  let out = String(text ?? "");
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}
