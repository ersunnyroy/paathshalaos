import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  requestId: string;
  /** Resolved from the verified token or API key. NEVER from a header or body. */
  tenantId?: string | undefined;
  actorId?: string | undefined;
  actorRole?: string | undefined;
  roles?: string[] | undefined;
  sessionId?: string | undefined;
  /** Set when the caller is an API client rather than a signed-in person. */
  apiClientId?: string | undefined;
  apiKeyId?: string | undefined;
  /** Set when the actor is a platform staff member inside an approved session. */
  impersonatedBy?: string | undefined;
  impersonationId?: string | undefined;
  impersonationWriteEnabled?: boolean | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: Partial<RequestContext>, fn: () => T): T {
  return storage.run({ requestId: ctx.requestId ?? randomUUID(), ...ctx }, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Use where the absence of a tenant is a programming error rather than an
 * authorisation decision — it should have been rejected by the auth guard long
 * before reaching here.
 */
export function requireTenantId(): string {
  const ctx = storage.getStore();
  if (!ctx?.tenantId) {
    throw new Error('No tenant in request context. A query was attempted outside a tenant scope.');
  }
  return ctx.tenantId;
}
