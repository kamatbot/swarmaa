import { AppError, requireCondition } from './errors.js';

export function object(value: unknown): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 400, 'invalid_arguments', 'Arguments must be an object.');
  return value as Record<string, unknown>;
}

export function string(value: unknown, name: string, max = 4000): string {
  requireCondition(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\u0000'), 400, 'invalid_arguments', `${name} must be a nonempty string of at most ${max} characters.`);
  return value;
}

export function optionalString(value: unknown, name: string, max = 4000): string | undefined {
  return value === undefined || value === null ? undefined : string(value, name, max);
}

export function integer(value: unknown, name: string, min: number, max: number): number {
  requireCondition(typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max, 400, 'invalid_arguments', `${name} must be an integer between ${min} and ${max}.`);
  return value;
}

export function strings(value: unknown, name: string, maxItems = 20, maxLength = 128): string[] {
  requireCondition(Array.isArray(value) && value.length <= maxItems, 400, 'invalid_arguments', `${name} must be an array of at most ${maxItems} strings.`);
  return [...new Set(value.map(v => string(v, name, maxLength)))];
}

export function enumValue<T extends string>(value: unknown, name: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new AppError(400, 'invalid_arguments', `${name} must be one of: ${values.join(', ')}.`);
  return value as T;
}

export function scopeName(value: unknown): string {
  const scope = string(value, 'scope', 128);
  requireCondition(/^[a-z][a-z0-9:_/.-]*$/.test(scope), 400, 'invalid_scope', 'Scope must use lowercase letters, digits, and : _ / . - only.');
  return scope;
}

export function boundedJson(value: unknown, name: string, maxBytes = 64 * 1024): unknown {
  const data = JSON.stringify(value);
  requireCondition(data !== undefined && Buffer.byteLength(data) <= maxBytes, 400, 'invalid_arguments', `${name} exceeds the allowed size.`);
  return value;
}

export function uuid(value: unknown, name: string): string {
  const id = string(value, name, 36);
  requireCondition(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id), 400, 'invalid_arguments', `${name} must be a UUID.`);
  return id;
}
