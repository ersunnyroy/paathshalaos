import { getApiBaseUrl } from './apiBase';

type QueryValue = string | number | boolean | undefined | null;

function withQuery(path: string, params?: Record<string, QueryValue>): string {
    if (!params) return path;
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        sp.set(key, String(value));
    }
    const q = sp.toString();
    return q ? `${path}?${q}` : path;
}

/**
 * Pathnames and query strings relative to {@link getApiBaseUrl} (leading slash, no duplicate `/api`).
 */
export const apiRoutes = {
    upload: () => '/upload',

    auth: {
        register: () => '/auth/register',
        login: () => '/auth/login',
        logout: () => '/auth/logout',
        me: () => '/auth/me',
        tenant: (subdomain: string) => withQuery('/auth/tenant', { subdomain }),
    },

    branches: {
        collection: (params?: Record<string, QueryValue>) => withQuery('/branches', params),
        byId: (id: number) => `/branches/${id}`,
    },

    roles: {
        collection: (params?: Record<string, QueryValue>) => withQuery('/roles', params),
        byId: (id: number) => `/roles/${id}`,
        permissions: (id: number) => `/roles/${id}/permissions`,
        assignToUser: () => '/users/assign-role',
    },

    permissions: {
        collection: (params?: Record<string, QueryValue>) => withQuery('/permissions', params),
    },

    modules: {
        collection: () => '/modules',
        toggle: (id: number) => `/modules/${id}/toggle`,
        tenantModules: () => '/tenant/modules',
    },

    features: {
        collection: () => '/features',
        toggle: (id: number) => `/features/${id}/toggle`,
        tenantFeatures: () => '/tenant/features',
        check: (feature: string) => withQuery('/check-feature', { feature }),
    },

    tenants: {
        collection: (params?: Record<string, QueryValue>) => withQuery('/tenants', params),
        byId: (id: number) => `/tenants/${id}`,
        toggleStatus: (id: number) => `/tenants/${id}/toggle-status`,
        stats: () => '/tenants/stats',
    },

    users: {
        collection: (params?: Record<string, QueryValue>) => withQuery('/users', params),
        byId: (id: number) => `/users/${id}`,
    },

    references: {
        countries: () => '/references/countries',
        states: (countryId?: number) =>
            countryId != null ? withQuery('/references/states', { country_id: countryId }) : '/references/states',
        instituteTypes: () => '/references/institute-types',
        boards: (countryId?: number) =>
            countryId != null ? withQuery('/references/boards', { country_id: countryId }) : '/references/boards',
        mediums: () => '/references/mediums',
    },
} as const;

/** Full URL for a path returned by {@link apiRoutes} (or any path starting with `/`). */
export function apiUrl(path: string): string {
    return `${getApiBaseUrl()}${path}`;
}
