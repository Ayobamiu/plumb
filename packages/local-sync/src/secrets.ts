// Never send file contents that look like secrets (AGENTS.md). Redact the
// obvious shapes before building sync text. Keep this small and predictable.
const REDACTED = "[redacted]";

const PATTERNS: RegExp[] = [
  // PEM private keys, whole block.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // bearer: keep the scheme word, drop the credential.
  /\b(Bearer)\s+[A-Za-z0-9\-._~+/=]{16,}\b/g,
  // named secrets: keep the name, drop the value.
  /\b(api[_-]?key|api[_-]?secret|secret[_-]?key|client[_-]?secret|password|passwd|token)\b(\s*[:=]\s*)\S+/gi,
  // known token prefixes.
  /\b(dte_|ghp_|gho_|ghu_|xox[bap]-|sk-)[A-Za-z0-9\-._~+/=]{8,}\b/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(PATTERNS[0]!, REDACTED);
  out = out.replace(PATTERNS[1]!, `$1 ${REDACTED}`);
  out = out.replace(PATTERNS[2]!, `$1$2${REDACTED}`);
  out = out.replace(PATTERNS[3]!, REDACTED);
  return out;
}
