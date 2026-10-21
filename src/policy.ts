import { AppError } from './errors.js';
import type { Permission, Principal } from './types.js';

export function hasPermission(principal: Principal, permission: Permission): boolean {
  return principal.permissions.includes('admin') || principal.permissions.includes(permission);
}

export function requirePermission(principal: Principal, permission: Permission): void {
  if (!hasPermission(principal, permission)) throw new AppError(403, 'forbidden', `This connection lacks ${permission}.`);
}

export function canAccessScope(principal: Principal, scope: string): boolean {
  return principal.scopes.includes(scope) || (principal.role === 'admin' && principal.scopes.includes('*'));
}

export function requireScope(principal: Principal, scope: string): void {
  if (!canAccessScope(principal, scope)) throw new AppError(403, 'scope_forbidden', 'This connection does not have access to that scope.');
}

export const ROLE_PERMISSIONS: Record<Principal['role'], Permission[]> = {
  admin: ['admin'],
  frontend: ['memory:read', 'memory:write', 'task:read', 'task:submit', 'task:cancel', 'artifact:read', 'events:read'],
  worker: ['memory:read', 'memory:write', 'task:read', 'task:claim', 'task:work', 'artifact:read', 'artifact:write', 'events:read'],
};
