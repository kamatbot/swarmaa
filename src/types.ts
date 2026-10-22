import type { Pool } from 'pg';

export type Role = 'admin' | 'frontend' | 'worker';
export type Permission = 'admin' | 'memory:read' | 'memory:write' | 'memory:moderate' | 'task:read' | 'task:submit' | 'task:claim' | 'task:work' | 'task:patch' | 'task:cancel' | 'artifact:read' | 'artifact:write' | 'events:read';

export interface Principal {
  id: string;
  tenantId: string;
  name: string;
  role: Role;
  scopes: string[];
  permissions: Permission[];
  credentialVersion?: number;
  /** Server-derived OAuth family id, for durable subscription revocation. */
  oauthGrantId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface ToolBackend {
  listTools(principal: Principal): ToolDefinition[];
  call(principal: Principal, name: string, args: unknown): Promise<unknown>;
}

export interface AuthBackend {
  authenticate(token: string): Promise<Principal | null>;
  getPrincipal(id: string): Promise<Principal | null>;
}

export interface EventBackend {
  handle(principal: Principal, method: string, params: unknown): Promise<unknown>;
}

export interface ServerConfig {
  host: string;
  port: number;
  publicUrl: string;
  allowedOrigins: string[];
  allowInsecureLocalhost: boolean;
  maxBodyBytes: number;
  oauthEnabled: boolean;
  oauthRedirectHosts: string[];
  eventCallbackHosts: string[];
  eventEncryptionKey: string;
  /** Optional override for the WebAuthn RP ID (registrable domain of PUBLIC_URL by default). */
  passkeyRpId?: string;
}

export interface HttpDependencies {
  pool: Pool;
  core: ToolBackend;
  auth: AuthBackend;
  events?: EventBackend;
  config: ServerConfig;
}

export interface StoredEvent {
  id: string;
  tenant_id: string;
  scope: string;
  name: string;
  subject_id: string;
  payload: Record<string, unknown>;
  created_at: Date;
}
