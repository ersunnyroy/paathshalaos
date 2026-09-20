/**
 * The bridge from a verified request to a tenant-scoped database call.
 *
 * Every controller goes through here rather than assembling a scope itself. The
 * failure it prevents is small and fatal: a controller that forgets `actorId`
 * still works — the tenant policy passes — but every policy that keys on the
 * ACTOR (guardian scoping, finance scope, staff scope) silently resolves to
 * "nobody", and the endpoint returns an empty list instead of an error. An empty
 * list looks like "no data yet", which is how an authorisation bug ships.
 */
import { getContext, requireTenantId } from './request-context.ts';
import type { TenantScope } from '../db/tenant.ts';

export function currentScope(): TenantScope {
  const ctx = getContext();
  const actorId = ctx?.actorId;
  const apiClientId = ctx?.apiClientId;
  if (!actorId && !apiClientId) {
    // One guard or the other should have refused this request long before here.
    // Failing loudly beats querying as an anonymous principal and returning
    // nothing, which reads as "no data yet".
    throw new Error('No principal in request context; a guard should have refused this.');
  }
  return {
    tenantId: requireTenantId(),
    ...(actorId ? { actorId } : {}),
    ...(apiClientId ? { apiClientId } : {}),
  };
}

export function currentRoles(): string[] {
  return getContext()?.roles ?? [];
}
