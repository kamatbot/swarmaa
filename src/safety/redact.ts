// Secret redaction for stored chat turns, lessons and distill prompts.
// Adapted from Asymptote Labs agent-beacon (MIT): pkg/asymptoteobserve/privacy.go (rule list, key-name rule,
// repeated-assigned-value removal). Go RE2 patterns are rebuilt as JS RegExp from strings, because the source
// uses inline modifiers `(?-i:...)`. Not ported: the per-rule needle gate (a Go regexp-speed optimisation; two
// cheap pre-checks stand in for it), SanitizeEvent and string truncation.
// Extra rules for this service: its own `cn_` connection tokens and xAI `xai-` keys.

export const REDACTED = '[REDACTED]';
const BT = '`';

// A label that marks the value after it as a secret (`token`, `GITHUB_TOKEN`, `api_key`, `"password"`). It must end in
// the marker, so `input_tokens: 812` and `max_tokens=4096` stay readable.
const LABEL = String.raw`[A-Za-z0-9_.-]*?(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|token|secret|password|passwd|passphrase|authorization|credentials?)`;
// From the end of a label to its value: optional closing quote (escaped too, for JSON inside a string) and separator.
const SEPARATOR = String.raw`(?:\\?["'${BT}])?\s*[:=]\s*`;
const OPEN_QUOTE = String.raw`\\?["'${BT}]`;

const inQuotes = (q: string): string => String.raw`(?:[^${q}\\\n]|\\[^\n])+`;
const inEscapedQuotes = (q: string): string => String.raw`(?:[^${q}\\\n]|\\\\\\${q}|\\[^${q}\n])+`;
// [opening, body] pairs: an escaped and a plain opening for each quote character.
const QUOTED: [string, string][] = [
  [String.raw`\\"`, inEscapedQuotes('"')], ['"', inQuotes('"')],
  [String.raw`\\'`, inEscapedQuotes("'")], ["'", inQuotes("'")],
  [String.raw`\\${BT}`, inEscapedQuotes(BT)], [BT, inQuotes(BT)],
];
// Unquoted value up to a quote, comma or whitespace; brackets and braces belong to it (generated passwords).
const UNQUOTED = String.raw`(?:[^"'${BT},\s\\]|\\[^"'${BT}])[^"'${BT},\s]*`;
// Bare value after a quoted label: a JSON number or literal.
const BARE = String.raw`[^"'${BT}\\\s,{}\[\]][^"'${BT}\\\s,{}\[\]]*`;
// A command-line flag named for a secret: `--password `, `--token=`, `-api-key `.
const FLAG = String.raw`(?:^|\s)--?[a-z0-9-]*(?:password|passwd|passphrase|token|secret|api-?key|access-?key)(?:=|\s+)`;

const isAuthScheme = (value: string): boolean => {
  const f = value.trim().split(/\s+/).filter(Boolean);
  if (f.length === 0 || f.length > 2 || (f.length === 2 && f[1] !== REDACTED)) return false;
  return ['bearer', 'basic', 'token', 'digest'].includes(f[0]!.toLowerCase());
};
const isRedactedJwtPrefix = (value: string): boolean => value === 'eyJ';
const isLiteralOrAuthScheme = (value: string): boolean => ['null', 'true', 'false'].includes(value) || isAuthScheme(value);

type Gate = 'label' | 'flag';
interface Rule { re: RegExp; to: string; keep?: (value: string) => boolean; gate?: Gate }
const rule = (pattern: string, to: string, o: { flags?: string; keep?: (v: string) => boolean; gate?: Gate } = {}): Rule =>
  ({ re: new RegExp(pattern, o.flags ?? 'g'), to, keep: o.keep, gate: o.gate });
const quotedRules = (prefix: string, gate: Gate, keep?: (v: string) => boolean): Rule[] =>
  QUOTED.map(([open, body]) => rule(`(${prefix}${open})(?<value>${body})`, '${1}' + REDACTED, { flags: 'gi', keep, gate }));

const RULES: Rule[] = [
  // Private key block; the header must be followed by key material so code that only names the header is kept.
  rule(String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----(?:\s|\\[rn]|(?:Proc-Type|DEK-Info|Comment|Version):[^\n\\]*)*[A-Za-z0-9+/=]{16,}[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)`, REDACTED),
  // Authorization header credential after its scheme; a JWT keeps its public eyJ prefix.
  rule(String.raw`(authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)\s+(?-i:eyJ)?)([^"'\s,]+)()`, '${1}' + REDACTED, { flags: 'gi', gate: 'label' }),
  rule(String.raw`(\bbearer\s+(?-i:eyJ)?)(?<value>[a-z0-9._~+/=-]+)`, '${1}' + REDACTED, { flags: 'gi', keep: isRedactedJwtPrefix }),
  // Labeled assignment: `token=x`, `export GITHUB_TOKEN="x"`, `{"api_key": "x"}`.
  ...quotedRules(String.raw`\b${LABEL}${SEPARATOR}`, 'label', isAuthScheme),
  // Quoted label with a bare value (JSON number or literal): replacement is quoted the way the label is.
  rule(String.raw`(\b${LABEL}(?<q>${OPEN_QUOTE})\s*[:=]\s*)(?<value>${BARE})`, '${1}${q}' + REDACTED + '${q}', { flags: 'gi', keep: isLiteralOrAuthScheme, gate: 'label' }),
  rule(String.raw`(\b${LABEL}\s*[:=]\s*)(?<value>${UNQUOTED})`, '${1}' + REDACTED, { flags: 'gi', keep: isAuthScheme, gate: 'label' }),
  // Command-line flags, quoted or not.
  ...quotedRules(FLAG, 'flag'),
  rule(String.raw`(${FLAG})([^\s"'-][^\s"']*)`, '${1}' + REDACTED, { flags: 'gi', gate: 'flag' }),
  // Password in URL userinfo: `postgres://user:pw@host`.
  rule(String.raw`(\b[a-z][a-z0-9+.-]*://[^/\s:@"'<>]+:)([^@/\s"'<>]+)(@)`, '${1}' + REDACTED + '${3}', { flags: 'gi' }),
  // Credentials recognisable by shape; the public type prefix stays (`ghp_[REDACTED]`).
  rule(String.raw`\b(sk-)[A-Za-z0-9_-]{20,}`, '${1}' + REDACTED),
  rule(String.raw`(\b(?:AKIA|ASIA)[A-Z0-9]{16}\b[\s,:|"']{1,8})[A-Za-z0-9/+]{40}([^A-Za-z0-9/+=]|$)`, '${1}' + REDACTED + '${2}'),
  rule(String.raw`\b(AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b`, '${1}' + REDACTED),
  rule(String.raw`\b(gh[pousr]_)[A-Za-z0-9]{30,}`, '${1}' + REDACTED),
  rule(String.raw`\b(github_pat_)[A-Za-z0-9_]{22,}`, '${1}' + REDACTED),
  rule(String.raw`\b(glpat-)[A-Za-z0-9_-]{20,}`, '${1}' + REDACTED),
  rule(String.raw`\b(xox[abposr]-)[A-Za-z0-9-]{10,}`, '${1}' + REDACTED),
  rule(String.raw`\b([rs]k_(?:live|test)_)[A-Za-z0-9]{16,}`, '${1}' + REDACTED),
  rule(String.raw`\b(AIza)[0-9A-Za-z_-]{35}`, '${1}' + REDACTED),
  rule(String.raw`\b(npm_)[A-Za-z0-9]{36}`, '${1}' + REDACTED),
  rule(String.raw`\b(hf_)[A-Za-z0-9]{30,}`, '${1}' + REDACTED),
  rule(String.raw`\b(eyJ)[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`, '${1}' + REDACTED),
  // This service's own connection tokens and xAI keys.
  rule(String.raw`\b(cn_)[A-Za-z0-9_-]{20,}`, '${1}' + REDACTED),
  rule(String.raw`\b(xai-)[A-Za-z0-9]{20,}`, '${1}' + REDACTED),
];

const expand = (to: string, caps: string[], named: Record<string, string>): string =>
  to.replace(/\$\{(\w+)\}/g, (_, k: string) => (/^\d+$/.test(k) ? caps[Number(k)] : named[k]) ?? '');

function apply({ re, to, keep }: Rule, text: string): string {
  return text.replace(re, (...args: unknown[]) => {
    const last = args.at(-1);
    const named = (typeof last === 'object' && last !== null ? last : {}) as Record<string, string>;
    const caps = args.slice(0, args.findIndex(a => typeof a === 'number')) as string[]; // [match, g1, g2, ...]
    if (keep && keep(named.value ?? caps[2] ?? '')) return caps[0]!;
    return expand(to, caps, named);
  });
}

// Cheap gates: the lazy label prefix is quadratic on long dotted runs, so skip those rules when no label can match.
const LABEL_GATE = /(?:key|secret|token|password|passwd|passphrase|authorization|credentials?)["'`\\]*\s*[:=]/i;
const FLAG_GATE = /--?[a-z0-9-]*(?:password|passwd|passphrase|token|secret|key)(?:=|\s)/i;

// Every copy of an assigned value elsewhere in the same text is removed too (`token=abc12345` ... `abc12345`).
const ASSIGNED = new RegExp(String.raw`\b${LABEL}${SEPARATOR}(?:${QUOTED.map(([open, body]) => `${open}(${body})`).join('|')}|(${UNQUOTED}))`, 'gi');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces credential-shaped substrings, keeping labels and a short public prefix so the credential type stays visible. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  const open = { label: LABEL_GATE.test(text), flag: FLAG_GATE.test(text) };
  const assigned = new Set<string>();
  if (open.label) {
    for (const m of text.matchAll(ASSIGNED)) {
      const copied = m.slice(1).filter(Boolean).join('');
      if (copied.length >= 8 && copied !== REDACTED && !isAuthScheme(copied)) assigned.add(copied);
    }
  }
  let out = text;
  for (const r of RULES) if (!r.gate || open[r.gate]) out = apply(r, out);
  if (assigned.size) {
    const values = [...assigned].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, 64);
    out = out.replace(new RegExp(values.map(escapeRe).join('|'), 'g'), REDACTED);
  }
  return out;
}

const KEY_SUFFIXES = ['password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'accesskey', 'secretkey', 'privatekey', 'authorization', 'credential', 'credentials', 'cookie'];

/** True when a structured field name says its value is a credential (`apiKey`, `X-Api-Key`, `GITHUB_TOKEN`, `Cookie`). `input_tokens`, `author` and `PWD` are not. */
export function isSecretKeyName(key: string): boolean {
  const name = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return KEY_SUFFIXES.some(s => name.endsWith(s));
}

/** Deep copy of a JSON value: strings under secret-named keys are replaced, every other string goes through redactSecrets. */
export function redactJson(value: unknown): unknown {
  const walk = (v: unknown, secret: boolean): unknown => {
    if (typeof v === 'string') return secret && v !== '' ? REDACTED : redactSecrets(v);
    if (Array.isArray(v)) return v.map(item => walk(item, secret));
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, walk(item, isSecretKeyName(k))]));
    return v;
  };
  return walk(value, false);
}
