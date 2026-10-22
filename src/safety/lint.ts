// Safety lint for lesson text. Findings are flags for the reviewer; only invisible characters are rejected outright.
// Adapted from Asymptote Labs agent-beacon (MIT): the single-event regex rules under rules/prompt-injection,
// rules/risky-command and rules/credential-access. CEL `matches("(?i)...")` becomes a JS RegExp with the `i` flag and
// `\x{...}` becomes `\u{...}` with the `u` flag. Beacon matches one event field (a prompt, a command or a file path);
// a lesson is prose that quotes commands and paths, so:
//   - credential-file-read: `(^|/)` / `$` path anchors become token-boundary lookarounds, and a bare word
//     "credentials" is not a hit (only `/credentials`, `credentials.json|toml`);
//   - chmod: the `(^|[;&|]\s*)` command-start anchor becomes "not inside a longer word/path" so `chmod 777` in backticks hits;
//   - the command rules use the `m` flag so `$` is a line end.
// Rule ids keep Beacon's names. `keychain-dump` is this service's own addition (Beacon has no keychain rule).

interface LintRule { id: string; test: (text: string) => boolean }

const any = (id: string, ...res: RegExp[]): LintRule => ({ id, test: t => res.some(re => re.test(t)) });
const all = (id: string, ...res: RegExp[]): LintRule => ({ id, test: t => res.every(re => re.test(t)) });

/** Unicode tag characters, bidi controls and zero-width spacing used to smuggle text past a human reviewer (ZWJ/ZWNJ excluded). */
export const INVISIBLE = /[\u{E0000}-\u{E007F}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200B}\u{2060}\u{FEFF}]/u;
export const hasInvisible = (text: string): boolean => INVISIBLE.test(text);

const RULES: LintRule[] = [
  // rules/prompt-injection
  any('ignore-previous-instructions', /(ignore|disregard|forget)\s+(all\s+|the\s+|your\s+)?(previous|prior|earlier|above|system)\s+(instructions|prompts?|rules?)/i),
  any('role-override-jailbreak', /(you\s+are\s+now|from\s+now\s+on\s+you\s+are|act\s+as|pretend\s+(you|to\s+be)|enable\s+|enter\s+|switch\s+to)\b.{0,40}(dan\b|developer\s+mode|jailbreak|unrestricted|no\s+(restrictions|filters?|rules?|limits?|guidelines?)|without\s+(restrictions|filters?|any\s+rules?|limitations?)|ignore\s+(all\s+)?(safety|content)\s+(policies|filters?|guidelines?))/i),
  any('exfiltrate-system-prompt', /(reveal|repeat|print|show|output|tell me)\b.{0,40}(system\s+prompt|initial\s+(instructions|prompt)|your\s+(instructions|system\s+prompt))/i),
  all('exfiltrate-context-secrets',
    /\b(reveal|print|show|output|list|dump|tell\s+me|give\s+me|share|disclose|repeat)\b.{0,50}\b(api[\s_-]?keys?|secret\s*keys?|secrets?|access\s+tokens?|auth\s+tokens?|bearer\s+tokens?|credentials?|passwords?|private\s+keys?|environment\s+variables?|env\s+vars?)\b/i,
    /\b(you\s+(have|can\s+see|were\s+given|know|have\s+access\s+to)|in\s+(your\s+)?(context|memory|the\s+conversation|this\s+session)|available\s+to\s+you|that\s+(you|are)|all\s+(the\s+)?(secrets?|keys?|tokens?|credentials?))\b/i),
  any('exfiltrate-context-via-markdown-image', /(encode|append|embed|include|put|place|add)\b.{0,60}(conversation|context|history|secret|token|api[\s_-]?key|password|env|the\s+above|previous\s+messages?)\b.{0,60}(markdown\s+image|!\[|\]\(https?:\/\/|url|query\s+string|image\s+(url|link|tag))/i),
  all('decode-and-execute-injection',
    /\b(decode|decrypt|base64\s*-?\s*decode|un-?escape|rot13|from\s+hex|de-?obfuscate)\b/i,
    /\b(then|and|after\s+(that|decoding))\b.{0,40}(follow|execute|run|obey|do\s+(what|as|exactly)|carry\s+out|comply\s+with|treat\s+(it|the\s+result)\s+as\s+(instructions|a\s+command|your\s+instructions))/i),
  any('indirect-injection-new-instructions-marker', /(new|updated|important|additional|override|special|secret)\s+(system\s+)?(instructions?|directives?|prompt|message|note)\b.{0,40}(for\s+(the\s+)?(ai|assistant|model|llm|agent|chatbot)|to\s+(the\s+)?(ai|assistant|model|llm|agent)|:?\s*(you\s+must|the\s+(assistant|ai|model|agent)\s+(must|should|shall)))/i),
  { id: 'invisible-character-prompt-injection', test: hasInvisible },
  // rules/risky-command
  any('curl-pipe-to-shell', /\b(curl|wget)\b.*\|\s*(sudo\s+)?(ba|z)?sh\b/im),
  all('base64-decode-piped-to-shell', /\bbase64\b\s+(-d|-D|--decode)\b/i, /\|\s*(sudo\s+)?(ba|z)?sh\b/i),
  any('recursive-root-delete', /\brm\s+-[a-z]*[rf][a-z]*\s+(\/|~|\$HOME|\*)(\s|$|\/)/im),
  any('world-writable-chmod', /(?<![\w./-])chmod\s+([^;&|]*\s)?(0?777\b|([ugoa]*[oa][ugoa]*)[+=][rwx]*w[rwx]*\b)/i),
  any('persistence-install-command', /\bcrontab\b\s+(-($|[\s|])|-e\b|[^-\s])/im, /\bsystemctl\b(\s+--user)?\s+enable\b/i, /\blaunchctl\b\s+(load|bootstrap|enable)\b/i),
  // rules/credential-access (credential-file-read), adapted to prose
  any('credential-file-read',
    /(?<![\w.-])\.env(?![\w-])/i, /\.aws\/credentials/i, /(?<![\w.-])id_(rsa|ed25519|ecdsa|dsa)(?![\w-])(?!\.pub)/i,
    /(?<![\w.-])\.git-credentials(?![\w-])/i, /\/\.config\/git\/credentials(?![\w-])/i, /(?<![\w.-])(\.netrc|\.pgpass)(?![\w-])/i,
    /\/credentials(\.json|\.toml)?(?![\w-])/i, /(?<![\w./-])credentials\.(json|toml)(?![\w-])/i),
  // own addition: macOS keychain dumps
  any('keychain-dump', /\bsecurity\s+dump-keychain\b/i, /\bsecurity\s+find-(generic|internet)-password\b[^\n]*\s-[a-z]*w/i),
];

/** Ids of every rule the text trips, in rule order. Findings are advisory flags except `invisible-character-prompt-injection`, which propose rejects. */
export function lintLesson(text: string): string[] {
  return RULES.filter(r => r.test(text)).map(r => r.id);
}
