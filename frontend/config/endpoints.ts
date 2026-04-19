export const API_ENDPOINTS = {
    AUTH_LOGIN: '/auth/login',
    AUTH_LOGOUT: '/auth/logout',
    AUTH_ME: '/auth/me',
    AUTH_REFRESH: '/auth/refresh',
    AUTH_TENANT: '/auth/tenant',
    TENANTS: '/tenants',
    TENANTS_STATS: '/tenants/stats',
    TENANTS_CHECK_SUBDOMAIN: '/tenants/check-subdomain',
    TENANTS_CHECK_DOMAIN: '/tenants/check-domain',
    BRANCHES: '/branches',
    USERS: '/users',
    ROLES: '/roles',
    ROLES_ASSIGN_PERMISSIONS: '/roles/{id}/permissions',
    PERMISSIONS: '/permissions',
    FEATURES: '/features',
    TENANT_FEATURES: '/tenant/features',
    REFERENCES_COUNTRIES: '/references/countries',
    REFERENCES_STATES: '/references/states',
    REFERENCES_INSTITUTE_TYPES: '/references/institute-types',
    REFERENCES_BOARDS: '/references/boards',
    REFERENCES_MEDIUMS: '/references/mediums',
};

export type EndpointKey = keyof typeof API_ENDPOINTS;

export function getEndpoint(key: EndpointKey, params?: Record<string, string | number>): string {
    let endpoint = API_ENDPOINTS[key];
    
    if (params) {
        Object.entries(params).forEach(([k, value]) => {
            endpoint = endpoint.replace(`{${k}}`, String(value));
        });
    }

    return endpoint;
}

export const ENDPOINT_METHODS: Record<EndpointKey, 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'> = {
    AUTH_LOGIN: 'POST',
    AUTH_LOGOUT: 'POST',
    AUTH_ME: 'GET',
    AUTH_REFRESH: 'POST',
    AUTH_TENANT: 'GET',
    TENANTS: 'GET',
    TENANTS_STATS: 'GET',
    TENANTS_CHECK_SUBDOMAIN: 'GET',
    TENANTS_CHECK_DOMAIN: 'GET',
    BRANCHES: 'GET',
    USERS: 'GET',
    ROLES: 'GET',
    ROLES_ASSIGN_PERMISSIONS: 'POST',
    PERMISSIONS: 'GET',
    FEATURES: 'GET',
    TENANT_FEATURES: 'GET',
    REFERENCES_COUNTRIES: 'GET',
    REFERENCES_STATES: 'GET',
    REFERENCES_INSTITUTE_TYPES: 'GET',
    REFERENCES_BOARDS: 'GET',
    REFERENCES_MEDIUMS: 'GET',
};