// Secret redaction for stored chat turns and lessons. Interim rule set; extended with the full port.
const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]'],
  [/\b(sk-[A-Za-z0-9_-]{2,6})[A-Za-z0-9_-]{16,}/g, '$1[redacted]'],
  [/\b(cn_)[A-Za-z0-9_-]{20,}/g, '$1[redacted]'],
  [/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g, '$1[redacted]'],
  [/\b(xai-)[A-Za-z0-9]{20,}/g, '$1[redacted]'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '$1[redacted]'],
];

/** Replaces credential-shaped substrings, keeping a short prefix so the credential type stays visible. */
export function redactSecrets(text: string): string {
  return RULES.reduce((out, [re, sub]) => out.replace(re, sub), text);
}
