import { createContext, useContext } from 'react';
import type { ApiResponse, JsonBody, httpRequest } from '@/lib/httpClient';
import { httpClient } from '@/lib/httpClient';
import { API, getApiUrl, API_BASE_URL } from '@/lib/apiConfig';
import { tenantService, TenantInfo } from './tenant';

export type { ApiResponse, JsonBody, httpRequest };
export { httpClient, API, getApiUrl, API_BASE_URL, tenantService };

const API_AUTH = API.auth;
const API_TENANTS = API.tenants;
const API_USERS = API.users;
const API_BRANCHES = API.branches;
const API_ROLES = API.roles;
const API_MODULES = API.modules;
const API_FEATURES = API.features;

function resolveEndpoint(endpoint: string | ((id: number) => string), id: number): string {
    return typeof endpoint === 'function' ? endpoint(id) : endpoint;
}

function resolveListEndpoint(endpoint: string | ((params?: Record<string, string>) => string), params?: Record<string, string>): string {
    return typeof endpoint === 'function' ? endpoint(params) : endpoint;
}

class ApiService {
    private getToken(): string | null {
        if (typeof window === 'undefined') return null;
        return localStorage.getItem('token');
    }

    async get<T = any>(endpoint: string): Promise<ApiResponse<T>> {
        return httpClient.get<T>(endpoint);
    }

    async post<T = any>(endpoint: string, data?: unknown): Promise<ApiResponse<T>> {
        return httpClient.post<T>(endpoint, data as JsonBody | undefined);
    }

    async put<T = any>(endpoint: string, data: unknown): Promise<ApiResponse<T>> {
        return httpClient.put<T>(endpoint, data as JsonBody);
    }

    async postWithFormData<T = any>(endpoint: string, formData: FormData): Promise<ApiResponse<T>> {
        return httpClient.post<T>(endpoint, undefined, formData);
    }

    async putWithFormData<T = any>(endpoint: string, formData: FormData): Promise<ApiResponse<T>> {
        return httpClient.put<T>(endpoint, undefined, formData);
    }

    async patch<T = any>(endpoint: string, data: unknown): Promise<ApiResponse<T>> {
        return httpClient.patch<T>(endpoint, data as JsonBody);
    }

    async delete<T = any>(endpoint: string): Promise<ApiResponse<T>> {
        return httpClient.delete<T>(endpoint);
    }

    async postMultipart<T = any>(endpoint: string, formData: FormData): Promise<ApiResponse<T>> {
        return httpClient.postMultipart<T>(endpoint, formData);
    }

    setToken(token: string) {
        localStorage.setItem('token', token);
    }

    removeToken() {
        localStorage.removeItem('token');
    }

    isAuthenticated(): boolean {
        return !!this.getToken();
    }

    clearAuth() {
        this.removeToken();
        tenantService.clearTenant();
    }
}

export const api = new ApiService();

export const authService = {
    register: (data: {
        name: string;
        subdomain?: string;
        email: string;
        phone?: string;
        admin_name: string;
        password: string;
        password_confirmation: string;
    }) => api.post(API_AUTH.register, data),

    login: (credentials: {
        email_or_phone: string;
        password: string;
        tenant_id?: number;
    }) => api.post(API_AUTH.login, credentials),

    logout: () => api.post(API_AUTH.logout),

    me: () => api.get(API_AUTH.me),

    forgotPassword: (email: string) => api.post(API_AUTH.forgotPassword, { email }),
    
    resetPassword: (email: string, token: string, password: string) => 
        api.post(API_AUTH.resetPassword, { email, token, password }),
    
    changePassword: (currentPassword: string, newPassword: string) =>
        api.post(API_AUTH.changePassword, { current_password: currentPassword, new_password: newPassword }),
};

export const branchService = {
    getAll: (params?: Record<string, string>) => api.get(resolveListEndpoint(API_BRANCHES.list, params)),
    getById: (id: number) => api.get(resolveEndpoint(API_BRANCHES.show, id)),
    create: (data: any) => api.post(API_BRANCHES.create, data),
    update: (id: number, data: any) => api.put(resolveEndpoint(API_BRANCHES.update, id), data),
    delete: (id: number) => api.delete(resolveEndpoint(API_BRANCHES.delete, id)),
};

export const roleService = {
    getAll: (params?: Record<string, string>) => api.get(resolveListEndpoint(API_ROLES.list, params)),
    getById: (id: number) => api.get(resolveEndpoint(API_ROLES.show, id)),
    create: (data: any) => api.post(API_ROLES.create, data),
    update: (id: number, data: any) => api.put(resolveEndpoint(API_ROLES.update, id), data),
    delete: (id: number) => api.delete(resolveEndpoint(API_ROLES.delete, id)),
    assignPermissions: (id: number, permissionIds: number[]) =>
        api.post(resolveEndpoint(API_ROLES.permissions, id), { permission_ids: permissionIds }),
};

export const permissionService = {
    getAll: () => api.get(API.permissions?.list || '/api/permissions'),
};

export const moduleService = {
    getAll: () => api.get(API_MODULES.list),
    getTenantModules: () => api.get(API_MODULES.tenantModules),
    toggle: (id: number, isEnabled: boolean) => api.post(resolveEndpoint(API_MODULES.toggle, id), { is_enabled: isEnabled }),
};

export const featureService = {
    getAll: () => api.get(API_FEATURES.list),
    getTenantFeatures: () => api.get(API_FEATURES.tenantFeatures),
    checkFeature: (feature: string) => api.get(API_FEATURES.check + '?feature=' + feature),
    toggle: (id: number, isEnabled: boolean) => api.post(resolveEndpoint(API_FEATURES.toggle, id), { is_enabled: isEnabled }),
};

export const tenantAdminService = {
    getAll: () => api.get(API_TENANTS.list),
    getById: (id: number) => api.get(resolveEndpoint(API_TENANTS.show, id)),
    create: (data: any) => api.post(API_TENANTS.create, data),
    update: (id: number, data: any) => api.put(resolveEndpoint(API_TENANTS.update, id), data),
    delete: (id: number) => api.delete(resolveEndpoint(API_TENANTS.delete, id)),
    getStats: () => api.get(API_TENANTS.stats),
    toggleStatus: (id: number, status: number) => api.post(resolveEndpoint(API_TENANTS.toggleStatus, id), { status }),
};

export const userService = {
    getAll: (params?: Record<string, string>) => api.get(resolveListEndpoint(API_USERS.list, params)),
    getById: (id: number) => api.get(resolveEndpoint(API_USERS.show, id)),
    create: (data: any) => api.post(API_USERS.create, data),
    update: (id: number, data: any) => api.put(resolveEndpoint(API_USERS.update, id), data),
    delete: (id: number) => api.delete(resolveEndpoint(API_USERS.delete, id)),
};

export const TenantContext = createContext<{
    tenant: TenantInfo | null;
    loading: boolean;
    isMultiTenant: boolean;
    refreshTenant: () => Promise<void>;
}>({
    tenant: null,
    loading: true,
    isMultiTenant: false,
    refreshTenant: async () => {},
});

export function useTenant() {
    return useContext(TenantContext);
}