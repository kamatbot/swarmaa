// Fixtures in tests/fixtures/beacon-lint-fixtures.json and the redaction cases below are adapted from
// Asymptote Labs agent-beacon (MIT): rules/*/*.rule.yaml tests and pkg/asymptoteobserve/privacy_test.go.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { hasInvisible, lintLesson } from '../src/safety/lint.js';
import { isSecretKeyName, redactJson, redactSecrets } from '../src/safety/redact.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/beacon-lint-fixtures.json', import.meta.url), 'utf8')) as
  Record<string, { name: string; verdict: 'match' | 'no_match'; text: string }[]>;

describe('lintLesson (beacon rule fixtures)', () => {
  for (const [rule, cases] of Object.entries(fixtures)) {
    for (const c of cases) {
      it(`${rule}: ${c.name} -> ${c.verdict}`, () => {
        const found = lintLesson(c.text);
        if (c.verdict === 'match') assert.ok(found.includes(rule), `expected ${rule} in ${JSON.stringify(found)} for ${JSON.stringify(c.text)}`);
        else assert.ok(!found.includes(rule), `unexpected ${rule} for ${JSON.stringify(c.text)}`);
      });
    }
  }

  it('keychain-dump (own rule)', () => {
    assert.ok(lintLesson('run `security dump-keychain -d login.keychain`').includes('keychain-dump'));
    assert.ok(lintLesson('security find-generic-password -s github -w').includes('keychain-dump'));
    assert.ok(!lintLesson('security find-generic-password -s github').includes('keychain-dump'));
  });

  it('prose adaptations: backticked chmod hits, plain word credentials does not', () => {
    assert.ok(lintLesson('Never run `chmod 777 /srv` on the host.').includes('world-writable-chmod'));
    assert.deepEqual(lintLesson('Store credentials in the OS keychain, not in the repo.'), []);
  });

  it('an ordinary lesson has no findings and invisible characters are detectable', () => {
    const lesson = 'Run `npm run migrate` before restarting the service. The schema check fails otherwise (turns 4-7).';
    assert.deepEqual(lintLesson(lesson), []);
    assert.equal(hasInvisible('abc'), false);
    assert.equal(hasInvisible('a​b'), true);
    assert.equal(hasInvisible('\u{1F468}‍\u{1F469}'), false);
  });
});

describe('redactSecrets (privacy.go behavior)', () => {
  const removed: [string, string, string][] = [
    ['aws env', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'],
    ['aws credentials file', 'aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'],
    ['aws access key id', 'found AKIAIOSFODNN7EXAMPLE in the config', 'AKIAIOSFODNN7EXAMPLE'],
    ['json api_key', '{"api_key": "f00dfacecafebeef1234"}', 'f00dfacecafebeef1234'],
    ['json token', '{"token":"opaque-session-value-9"}', 'opaque-session-value-9'],
    ['escaped json', '{\\"password\\": \\"hunter2hunter2\\"}', 'hunter2hunter2'],
    ['export', 'export GITHUB_TOKEN="plain-value-1234567"', 'plain-value-1234567'],
    ['yaml', 'client_secret: s3cr3t-value-abc', 's3cr3t-value-abc'],
    ['anthropic', 'key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCd', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
    ['github classic', 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
    ['github fine-grained', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnopqrstuvwxyz'],
    ['clone url', 'git clone https://x-access-token:opaqueValue123@github.com/org/repo', 'opaqueValue123'],
    ['database url', 'DATABASE_URL=postgres://app:pa55w0rd@db.internal:5432/app', 'pa55w0rd'],
    ['bare database url', 'connect to postgres://app:pa55w0rd@db.internal:5432/app', 'pa55w0rd'],
    ['password flag', 'mysql --user root --password hunter2hunter2', 'hunter2hunter2'],
    ['token flag', 'tool login --token=opaque-flag-value', 'opaque-flag-value'],
    ['basic auth', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    ['slack', 'xoxb-1234567890-abcdefghijkl', 'abcdefghijkl'],
    ['stripe', 'sk_live_AbCdEfGhIjKlMnOpQrSt', 'AbCdEfGhIjKlMnOpQrSt'],
    ['google', 'AIzaSyA-abcdefghijklmnopqrstuvwxyz012345', 'abcdefghijklmnopqrstuvwxyz012345'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['service connection token', 'use cn_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abc for auth', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abc'],
    ['xai key', 'XAI xai-AbCdEfGhIjKlMnOpQrStUvWxYz0123', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123'],
    ['aws credentials csv', 'Access key ID,Secret access key\nAKIAIOSFODNN7EXAMPLE,wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['rsa key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretbody\n-----END RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAsecretbody'],
    ['openssh key cut short', 'cat ~/.ssh/id_ed25519\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA', 'b3BlbnNzaC1rZXktdjEAAAAA'],
    ['json-escaped pem', '{"output":"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n","ok":true}', 'MIIEvQIBADANBgkq'],
  ];
  for (const [name, input, secret] of removed) {
    it(`removes ${name}`, () => {
      const got = redactSecrets(input);
      assert.ok(!got.includes(secret) && got.includes('[REDACTED]'), `${JSON.stringify(input)} -> ${JSON.stringify(got)}`);
    });
  }

  it('keeps the public prefix, the label and the surrounding structure', () => {
    const want: Record<string, string> = {
      'deploy with ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789': 'deploy with ghp_[REDACTED]',
      'upload with AKIAIOSFODNN7EXAMPLE': 'upload with AKIA[REDACTED]',
      'Authorization: Bearer abc.def.ghi': 'Authorization: Bearer [REDACTED]',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig': 'Authorization: Bearer eyJ[REDACTED]',
      "curl -H 'Authorization: bearer eyJhbGciOiJ9.x.y'": "curl -H 'Authorization: bearer eyJ[REDACTED]'",
      '{"authorization": "Basic dXNlcjpwYXNz"}': '{"authorization": "Basic [REDACTED]"}',
      '{"api_key": "f00dfacecafebeef1234", "model": "x"}': '{"api_key": "[REDACTED]", "model": "x"}',
      'git clone https://u:pw123456@example.com/r': 'git clone https://u:[REDACTED]@example.com/r',
      'AKIAIOSFODNN7EXAMPLE,wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n': 'AKIA[REDACTED],[REDACTED]\n',
      '| AKIAIOSFODNN7EXAMPLE | wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY |': '| AKIA[REDACTED] | [REDACTED] |',
      'commit wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY has no key id beside it': 'commit wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY has no key id beside it',
    };
    for (const [input, out] of Object.entries(want)) assert.equal(redactSecrets(input), out, input);
  });

  it('takes whole values: brackets, quotes, spaces, escaped quotes, quoted flags', () => {
    const want: Record<string, string> = {
      'DB_PASSWORD=Xy7]kL9}pQ next': 'DB_PASSWORD=[REDACTED] next',
      'password=ab\\cdEFgh': 'password=[REDACTED]',
      'token=[abcDEF123]': 'token=[REDACTED]',
      'secret: "correct horse, battery staple"': 'secret: "[REDACTED]"',
      "password='p]a}s\\\\s'": "password='[REDACTED]'",
      '{\\"token\\": \\"a]b}c d\\"}': '{\\"token\\": \\"[REDACTED]\\"}',
      'export TOKEN="ab\\"cdefgh1234" next': 'export TOKEN="[REDACTED]" next',
      '{"password": "pa\\"ss123secret"}': '{"password": "[REDACTED]"}',
      'DB_PASSWORD="ab\'cdEFGH12345" next': 'DB_PASSWORD="[REDACTED]" next',
      '{"password": "it\'s-my-pass"}': '{"password": "[REDACTED]"}',
      "password='say \"hi\" 123'": "password='[REDACTED]'",
      'docker login --password "hunter2 hunter2" registry': 'docker login --password "[REDACTED]" registry',
      "mysql --password 'p@ss' db": "mysql --password '[REDACTED]' db",
      'tool --token="opaque-value" run': 'tool --token="[REDACTED]" run',
    };
    for (const [input, out] of Object.entries(want)) assert.equal(redactSecrets(input), out, input);
  });

  it('leaves ordinary text and token counts alone', () => {
    for (const input of [
      'input_tokens: 812, output_tokens=95, max_tokens=4096', 'run go test ./... --max-tokens 10', 'the author: Ada',
      'see https://github.com/org/repo/pull/12 and git@github.com:org/repo.git', 'PWD=/home/ada/project',
      'task-0123456789abcdefghijklmnop', 'if (s.startsWith("-----BEGIN RSA PRIVATE KEY-----")) {\n  return parseRSA(s)\n}',
    ]) assert.equal(redactSecrets(input), input);
  });

  it('removes bare copies of an assigned value and is idempotent', () => {
    const got = redactSecrets('Use token=local-e2e-secret-value, then replace local-e2e-secret-value in the file.');
    assert.ok(!got.includes('local-e2e-secret-value'));
    assert.equal(got.split('[REDACTED]').length - 1, 2);
    for (const input of ['api_key=sk-abcdefghijklmnopqrstuvwxyz0123\nOPENAI sk-abcdefghijklmnopqrstuvwxyz0123',
      '{"token": "opaque-session-value-9", "password": "hunter2hunter2"}', 'Authorization: Bearer abc.def.ghi and --password hunter2hunter2', 'postgres://app:pa55w0rd@db/app']) {
      const once = redactSecrets(input);
      assert.equal(redactSecrets(once), once);
    }
  });

  it('key-name rule', () => {
    for (const k of ['password', 'apiKey', 'X-Api-Key', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'client_secret', 'Cookie']) assert.ok(isSecretKeyName(k), k);
    for (const k of ['input_tokens', 'token_type', 'author', 'PWD', 'model']) assert.ok(!isSecretKeyName(k), k);
    const out = redactJson({ tool_input: { password: 'hunter2', headers: { 'X-Api-Key': 'abc', Cookie: ['sid=1', ''], Accept: 'application/json' }, env: { PWD: '/home/ada' } }, usage: { input_tokens: 12 }, token_type: 'Bearer' });
    assert.deepEqual(out, { tool_input: { password: '[REDACTED]', headers: { 'X-Api-Key': '[REDACTED]', Cookie: ['[REDACTED]', ''], Accept: 'application/json' }, env: { PWD: '/home/ada' } }, usage: { input_tokens: 12 }, token_type: 'Bearer' });
  });

  it('stays fast on a long dotted run', () => {
    const start = Date.now();
    redactSecrets(`token ${'a.'.repeat(4000)}`);
    redactSecrets('x'.repeat(100000));
    assert.ok(Date.now() - start < 2000);
  });
});
