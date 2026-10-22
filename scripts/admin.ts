import { randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { AuthService, hashToken, newToken, principalFromRow } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createPool, transaction } from '../src/db.js';
import { requireCondition } from '../src/errors.js';
import { EventService } from '../src/events.js';
import { PasskeyService } from '../src/passkeys.js';
import { GRANTABLE_PERMISSIONS, ROLE_PERMISSIONS } from '../src/policy.js';
import type { Permission, Role } from '../src/types.js';
import { enumValue, scopeName, string } from '../src/validation.js';

const { values, positionals } = parseArgs({
  allowPositionals: true, strict: true,
  options: {
    name: { type: 'string' }, role: { type: 'string' }, scopes: { type: 'string' },
    tenant: { type: 'string', default: 'personal' }, grant: { type: 'string', multiple: true },
    out: { type: 'string' }, scope: { type: 'string' }, event: { type: 'string', default: 'task.updated' },
    permission: { type: 'string' }, id: { type: 'string' }, days: { type: 'string', default: '7' }, minutes: { type: 'string', default: '30' },
  },
});
const command = positionals[0];
const commands = ['create', 'list', 'set-scopes', 'grant', 'revoke-grant', 'rotate', 'revoke', 'subscriptions', 'add-sink', 'remove-sink', 'passkey-invite'];
requireCondition(positionals.length === 1 && commands.includes(command), 400, 'usage', `Usage: npm run admin -- ${commands.join('|')} [options]. See docs/OPERATIONS.md.`);
const tenant = string(values.tenant, 'tenant', 100);
requireCondition(/^[a-z0-9][a-z0-9_-]*$/.test(tenant), 400, 'invalid_tenant', 'Tenant must use lowercase letters, digits, underscore and hyphen.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = createPool(process.env.DATABASE_URL);
// Reserve the destination before any identity mutation, so an existing/unwritable
// file cannot cause a successful credential rotation to lose its output.
const output = values.out ? await open(values.out, 'wx', 0o600) : undefined;
let outputWritten = false;

async function emit(value: unknown, secret = false): Promise<void> {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  if (output) {
    await output.writeFile(data, 'utf8');
    await output.sync();
    outputWritten = true;
    process.stderr.write('Wrote output to the requested new private file.\n');
  } else {
    if (secret) process.stderr.write('This is the only display of this token. Store it privately; do not paste it into chat.\n');
    process.stdout.write(data);
  }
}

async function lookupPrincipal() {
  const name = string(values.name, 'name', 100);
  const result = await pool.query('SELECT * FROM principals WHERE tenant_id=$1 AND name=$2', [tenant, name]);
  requireCondition(!!result.rows[0], 404, 'not_found', 'Principal was not found.');
  return result.rows[0];
}

function parseScopes(role: Role): string[] {
  const scopes = [...new Set(string(values.scopes, 'scopes', 4096).split(',').map(s => s.trim()))];
  requireCondition(scopes.length >= 1 && scopes.length <= 64, 400, 'invalid_scopes', 'Grant between one and 64 explicit scopes.');
  for (const scope of scopes) {
    if (scope === '*') requireCondition(role === 'admin', 400, 'invalid_scopes', 'Only local owner credentials may have a wildcard scope.');
    else scopeName(scope);
  }
  return scopes;
}

try {
  if (command === 'create') {
    const name = string(values.name, 'name', 100);
    requireCondition(/^[a-z][a-z0-9_.-]+$/.test(name), 400, 'invalid_name', 'Use a stable lowercase connection name, such as claude-macmini.');
    const role: Role = enumValue(values.role, 'role', ['admin', 'frontend', 'worker']);
    const scopes = parseScopes(role);
    const extra = (values.grant ?? []).map(v => enumValue<Permission>(v, 'grant', ['task:patch', 'task:submit', 'task:cancel']));
    requireCondition(!extra.includes('task:patch') || role === 'worker', 400, 'invalid_grant', 'task:patch is a worker execution grant.');
    const token = newToken();
    const id = randomUUID();
    const permissions = [...new Set([...ROLE_PERMISSIONS[role], ...extra])];
    await pool.query('INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, tenant, name, role, scopes, permissions, hashToken(token)]);
    await emit({ id, tenant, name, role, scopes, permissions, token }, true);
  } else if (command === 'list') {
    const result = await pool.query('SELECT id,name,role,scopes,permissions,disabled,created_at FROM principals WHERE tenant_id=$1 ORDER BY name', [tenant]);
    await emit(result.rows);
  } else if (command === 'set-scopes') {
    // OAuth grants intersect their snapshot with these scopes and event delivery rechecks
    // them, so removing a scope takes effect on the next request without a token change.
    const principal = await lookupPrincipal();
    const scopes = parseScopes(principal.role as Role);
    await transaction(pool, async client => {
      await client.query('UPDATE principals SET scopes=$2 WHERE id=$1', [principal.id, scopes]);
      await client.query('INSERT INTO audit_log(id,tenant_id,actor_id,operation,subject_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [randomUUID(), tenant, principal.id, 'principal.set-scopes', principal.id, JSON.stringify({ local_owner: true, scopes })]);
    });
    await emit({ id: principal.id, name: principal.name, scopes });
  } else if (command === 'grant' || command === 'revoke-grant') {
    // Reviewing lessons is never part of a role. The owner grants it to one named frontend identity.
    const permission = enumValue<Permission>(values.permission, 'permission', GRANTABLE_PERMISSIONS);
    const principal = await lookupPrincipal();
    requireCondition(principal.role === 'frontend', 400, 'invalid_grant', `${permission} can only be granted to frontend identities.`);
    requireCondition(command === 'revoke-grant' || !principal.disabled, 400, 'disabled', 'A revoked principal cannot be granted anything.');
    const permissions = await transaction(pool, async client => {
      const updated = await client.query<{ permissions: string[] }>(command === 'grant'
        ? 'UPDATE principals SET permissions=CASE WHEN $2=ANY(permissions) THEN permissions ELSE array_append(permissions,$2) END WHERE id=$1 RETURNING permissions'
        : 'UPDATE principals SET permissions=array_remove(permissions,$2) WHERE id=$1 RETURNING permissions', [principal.id, permission]);
      await client.query('INSERT INTO audit_log(id,tenant_id,actor_id,operation,subject_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [randomUUID(), tenant, principal.id, `principal.${command}`, principal.id, JSON.stringify({ local_owner: true, permission })]);
      return updated.rows[0]!.permissions;
    });
    await emit({ id: principal.id, name: principal.name, permissions });
  } else if (command === 'rotate' || command === 'revoke') {
    const principal = await lookupPrincipal();
    const token = command === 'rotate' ? newToken() : undefined;
    if (command === 'rotate') requireCondition(!principal.disabled, 400, 'disabled', 'A revoked principal stays disabled. Provision a new named connection to restore access.');
    await transaction(pool, async client => {
      if (token) await client.query('UPDATE principals SET token_hash=$2,credential_version=credential_version+1 WHERE id=$1', [principal.id, hashToken(token)]);
      else await client.query('UPDATE principals SET disabled=true,credential_version=credential_version+1 WHERE id=$1', [principal.id]);
      // Both actions invalidate derived OAuth credentials and stop autonomous callbacks.
      await client.query("DELETE FROM oauth_pending WHERE grant_snapshot->>'id'=$1", [principal.id]);
      await client.query('DELETE FROM oauth_codes WHERE principal_id=$1', [principal.id]);
      await client.query('UPDATE oauth_grants SET revoked_at=clock_timestamp() WHERE principal_id=$1', [principal.id]);
      await client.query('UPDATE event_subscriptions SET active=false,revision=revision+1,updated_at=clock_timestamp() WHERE principal_id=$1', [principal.id]);
      await client.query('INSERT INTO audit_log(id,tenant_id,actor_id,operation,subject_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [randomUUID(), tenant, principal.id, `principal.${command}`, principal.id, JSON.stringify({ local_owner: true })]);
    });
    await emit({ id: principal.id, name: principal.name, action: command, ...(token ? { token } : {}) }, !!token);
  } else if (command === 'passkey-invite') {
    // A secret one-time link: shown once, stored only as a hash, never logged.
    const config = loadConfig();
    const passkeys = new PasskeyService(pool, config);
    requireCondition(!!passkeys.rp, 409, 'passkeys_unavailable', 'Passkeys need the public HTTPS address.');
    const minutes = Number(values.minutes);
    requireCondition(Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440, 400, 'invalid_minutes', 'Use --minutes between 1 and 1440.');
    const code = await passkeys.createInvite(minutes);
    await emit({ url: `${config.publicUrl}/account?code=${code}`, expires_in_minutes: minutes }, true);
  } else if (command === 'subscriptions') {
    const result = await pool.query('SELECT s.id,p.name AS owner,s.scope,s.name AS event,s.mode,s.active,s.expires_at FROM event_subscriptions s JOIN principals p ON p.id=s.principal_id WHERE s.tenant_id=$1 ORDER BY s.created_at', [tenant]);
    await emit(result.rows);
  } else if (command === 'remove-sink') {
    const id = string(values.id, 'id', 100);
    const result = await pool.query('UPDATE event_subscriptions SET active=false,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING id', [tenant, id]);
    await emit({ removed: result.rows.map(row => row.id) });
  } else if (command === 'add-sink') {
    const row = await lookupPrincipal();
    requireCondition(!row.disabled, 403, 'disabled', 'The callback owner is disabled.');
    const url = string(process.env.CALLBACK_URL, 'CALLBACK_URL', 2048);
    let headers: Record<string, string>;
    try { headers = JSON.parse(process.env.CALLBACK_HEADERS_JSON ?? '{}') as Record<string, string>; }
    catch { throw new Error('CALLBACK_HEADERS_JSON must be valid JSON. Its contents are not displayed.'); }
    const service = new EventService(pool, new AuthService(pool), loadConfig());
    await emit(await service.registerGeneric(principalFromRow(row), { scope: scopeName(values.scope), name: values.event!, url, headers, ttlDays: Number(values.days) }));
  }
} finally {
  await output?.close();
  if (values.out && output && !outputWritten) await unlink(values.out).catch(() => undefined);
  await pool.end();
}
