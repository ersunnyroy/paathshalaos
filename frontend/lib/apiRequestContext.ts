/** Must stay aligned with `tenantService` persistence key. */
export const TENANT_INFO_STORAGE_KEY = 'tenant_info';

export function getBearerToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('token');
}

export function getTenantIdForRequestHeaders(): string | null {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem(TENANT_INFO_STORAGE_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as { id?: number };
        return parsed.id != null ? String(parsed.id) : null;
    } catch {
        return null;
    }
}
