import { TENANT_INFO_STORAGE_KEY } from '@/lib/apiRequestContext';
import { httpClient } from '@/lib/httpClient';
import { apiRoutes } from '@/lib/apiRoutes';

interface TenantInfo {
    id: number;
    name: string;
    subdomain: string;
    email: string;
    phone: string | null;
    logo: string | null;
    favicon: string | null;
    primary_color: string | null;
    secondary_color: string | null;
    address: string | null;
    website: string | null;
    institute_type: string | null;
}

const TENANT_KEY = TENANT_INFO_STORAGE_KEY;

function getCurrentSubdomain(): string | null {
    if (typeof window === 'undefined') return null;
    const host = window.location.host;
    const urlParams = new URLSearchParams(window.location.search);
    const tenantKey = urlParams.get('tenant_key');

    if (tenantKey) {
        return tenantKey;
    }

    if (host.includes('localhost') || host.includes('paathshala.local')) {
        const parts = host.split('.')[0];
        if (parts === 'localhost' || parts === 'paathshala' || parts === host) {
            return null;
        }
        return parts;
    }

    const baseDomain = 'paathshala.local';
    if (host.endsWith(baseDomain)) {
        return host.replace('.' + baseDomain, '').replace(baseDomain, '').replace('://', '').split('.')[0];
    }

    return null;
}

export const tenantService = {
    async fetch(): Promise<TenantInfo | null> {
        try {
            const subdomain = getCurrentSubdomain();
            if (!subdomain) {
                return null;
            }

            const data = await httpClient.get<TenantInfo>(apiRoutes.auth.tenant(subdomain));

            if (data.success && data.data) {
                this.setTenant(data.data);
                return data.data;
            }

            return null;
        } catch (error) {
            console.error('Error fetching tenant:', error);
            return null;
        }
    },

    async check(): Promise<{ found: boolean; tenant: TenantInfo | null }> {
        try {
            const subdomain = getCurrentSubdomain();
            if (!subdomain) {
                return { found: false, tenant: null };
            }

            const data = await httpClient.get<TenantInfo>(apiRoutes.auth.tenant(subdomain));

            if (data.success && data.data) {
                this.setTenant(data.data);
                return { found: true, tenant: data.data };
            }

            return { found: false, tenant: null };
        } catch (error) {
            console.error('Error fetching tenant:', error);
            return { found: false, tenant: null };
        }
    },

    setTenant(tenant: TenantInfo | null): void {
        if (typeof window === 'undefined') return;
        if (tenant) {
            localStorage.setItem(TENANT_KEY, JSON.stringify(tenant));
        } else {
            localStorage.removeItem(TENANT_KEY);
        }
    },

    getTenant(): TenantInfo | null {
        if (typeof window === 'undefined') return null;
        const stored = localStorage.getItem(TENANT_KEY);
        return stored ? JSON.parse(stored) : null;
    },

    clearTenant(): void {
        if (typeof window === 'undefined') return;
        localStorage.removeItem(TENANT_KEY);
    },

    isMultiTenant(): boolean {
        const subdomain = getCurrentSubdomain();
        return subdomain !== null && subdomain !== 'www';
    },

    resetForNewDomain(): void {
        this.clearTenant();
    },

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

export type { TenantInfo };