import { TENANT_INFO_STORAGE_KEY, TENANT_HOST_STORAGE_KEY } from '@/lib/apiRequestContext';
import { httpClient } from '@/lib/httpClient';
import { apiRoutes } from '@/lib/apiRoutes';

export interface TenantInfo {
    id: number;
    name: string;
    subdomain: string;
    email?: string;
    phone?: string | null;
    /** Raw storage path — use logo_url for display */
    logo?: string | null;
    /** Full resolvable URL for the logo */
    logo_url: string | null;
    /** Raw storage path — use favicon_url for display */
    favicon?: string | null;
    /** Full resolvable URL for the favicon */
    favicon_url: string | null;
    primary_color: string | null;
    secondary_color?: string | null;
    address?: string | null;
    website?: string | null;
    institute_type?: string | null;
    /** The resolved host this tenant was fetched for, e.g. "school.paathshalaos.com" */
    host?: string | null;
}

const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN || 'paathshalaos.com';

/**
 * Resolves the tenant host from the current browser context.
 *
 * Priority:
 * 1. `?tenant_key=foo` query param  → constructs `foo.{APP_DOMAIN}`
 * 2. Multi-part production hostname  → uses the full host as-is
 * 3. Local dev subdomain (*.paathshala.local)
 */
function resolveHost(): string | null {
    if (typeof window === 'undefined') return null;

    const urlParams = new URLSearchParams(window.location.search);
    const tenantKey = urlParams.get('tenant_key');
    if (tenantKey) {
        return `${tenantKey}.${APP_DOMAIN}`;
    }

    const browserHost = window.location.hostname;

    // Local dev: school.paathshala.local
    if (browserHost.endsWith('.paathshala.local')) {
        return browserHost;
    }

    // Production / staging: any multi-part host that isn't bare localhost
    if (!browserHost.includes('localhost') && !browserHost.includes('127.0.0.1')) {
        const parts = browserHost.split('.');
        if (parts.length > 2) {
            return browserHost;
        }
    }

    return null;
}

export const tenantService = {
    /**
     * Fetches tenant branding from `GET /api/tenant/info`.
     * The resolved host is sent as `X-Tenant-Host` header so the backend can
     * identify the tenant by domain (SaaS subdomain or white-label custom domain).
     * Stores both the tenant info and the resolved host in localStorage so all
     * subsequent API calls include the header automatically via httpClient.
     */
    async fetch(): Promise<TenantInfo | null> {
        try {
            const host = resolveHost();
            if (!host) return null;

            const data = await httpClient.get<TenantInfo>(
                apiRoutes.tenant.info(),
                { headers: { 'X-Tenant-Host': host } },
            );

            if (data.success && data.data) {
                this.setTenant(data.data);
                this.setResolvedHost(host);
                return data.data;
            }

            return null;
        } catch (error) {
            console.error('Error fetching tenant:', error);
            return null;
        }
    },

    /**
     * Like `fetch()` but returns `{ found, tenant }` so callers can distinguish
     * "no tenant context" (non-multi-tenant page) from "tenant not found" (404).
     */
    async check(): Promise<{ found: boolean; tenant: TenantInfo | null }> {
        try {
            const host = resolveHost();
            if (!host) return { found: false, tenant: null };

            const data = await httpClient.get<TenantInfo>(
                apiRoutes.tenant.info(),
                { headers: { 'X-Tenant-Host': host } },
            );

            if (data.success && data.data) {
                this.setTenant(data.data);
                this.setResolvedHost(host);
                return { found: true, tenant: data.data };
            }

            return { found: false, tenant: null };
        } catch (error) {
            console.error('Error fetching tenant:', error);
            return { found: false, tenant: null };
        }
    },

    /** True when a tenant host can be resolved from the current URL. */
    isMultiTenant(): boolean {
        return resolveHost() !== null;
    },

    // ── Persistence ──────────────────────────────────────────────────────────

    setTenant(tenant: TenantInfo | null): void {
        if (typeof window === 'undefined') return;
        if (tenant) {
            localStorage.setItem(TENANT_INFO_STORAGE_KEY, JSON.stringify(tenant));
        } else {
            localStorage.removeItem(TENANT_INFO_STORAGE_KEY);
        }
    },

    getTenant(): TenantInfo | null {
        if (typeof window === 'undefined') return null;
        const stored = localStorage.getItem(TENANT_INFO_STORAGE_KEY);
        return stored ? JSON.parse(stored) : null;
    },

    setResolvedHost(host: string | null): void {
        if (typeof window === 'undefined') return;
        if (host) {
            localStorage.setItem(TENANT_HOST_STORAGE_KEY, host);
        } else {
            localStorage.removeItem(TENANT_HOST_STORAGE_KEY);
        }
    },

    getResolvedHost(): string | null {
        if (typeof window === 'undefined') return null;
        return localStorage.getItem(TENANT_HOST_STORAGE_KEY);
    },

    clearTenant(): void {
        if (typeof window === 'undefined') return;
        localStorage.removeItem(TENANT_INFO_STORAGE_KEY);
        localStorage.removeItem(TENANT_HOST_STORAGE_KEY);
    },

    resetForNewDomain(): void {
        this.clearTenant();
    },

    // ── Admin helpers ─────────────────────────────────────────────────────────

    async getStats(): Promise<any> {
        try {
            return await httpClient.get(apiRoutes.tenants.stats());
        } catch (error) {
            console.error('Error fetching stats:', error);
            return { success: false, data: null };
        }
    },

    async getAll(params?: Record<string, any>): Promise<any> {
        try {
            return await httpClient.get(apiRoutes.tenants.collection(params));
        } catch (error) {
            console.error('Error fetching tenants:', error);
            return { success: false, data: null };
        }
    },
};
