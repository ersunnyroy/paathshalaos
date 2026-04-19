import { createContext, useContext } from 'react';
import type { ApiResponse, JsonBody } from '@/lib/httpClient';
import { httpClient } from '@/lib/httpClient';
import { apiRoutes } from '@/lib/apiRoutes';
import { tenantService, TenantInfo } from './tenant';

export type { ApiResponse, JsonBody } from '@/lib/httpClient';
export { httpClient, httpRequest } from '@/lib/httpClient';

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
    }) => api.post(apiRoutes.auth.register(), data),

    login: (credentials: {
        email_or_phone: string;
        password: string;
        tenant_id?: number;
    }) => api.post(apiRoutes.auth.login(), credentials),

    logout: () => api.post(apiRoutes.auth.logout()),

    me: () => api.get(apiRoutes.auth.me()),
};

export const branchService = {
    getAll: (params?: Record<string, any>) => api.get(apiRoutes.branches.collection(params)),
    getById: (id: number) => api.get(apiRoutes.branches.byId(id)),
    create: (data: any) => api.post(apiRoutes.branches.collection(), data),
    update: (id: number, data: any) => api.put(apiRoutes.branches.byId(id), data),
    delete: (id: number) => api.delete(apiRoutes.branches.byId(id)),
};

export const roleService = {
    getAll: (params?: Record<string, any>) => api.get(apiRoutes.roles.collection(params)),
    getById: (id: number) => api.get(apiRoutes.roles.byId(id)),
    create: (data: any) => api.post(apiRoutes.roles.collection(), data),
    update: (id: number, data: any) => api.put(apiRoutes.roles.byId(id), data),
    delete: (id: number) => api.delete(apiRoutes.roles.byId(id)),
    assignPermissions: (id: number, permissionIds: number[]) =>
        api.post(apiRoutes.roles.permissions(id), { permission_ids: permissionIds }),
    assignRoleToUser: (userId: number, roleId: number) =>
        api.post(apiRoutes.roles.assignToUser(), { user_id: userId, role_id: roleId }),
};

export const permissionService = {
    getAll: (params?: Record<string, any>) => api.get(apiRoutes.permissions.collection(params)),
};

export const moduleService = {
    getAll: () => api.get(apiRoutes.modules.collection()),
    toggle: (id: number, isEnabled: boolean) =>
        api.post(apiRoutes.modules.toggle(id), { is_enabled: isEnabled }),
    getTenantModules: () => api.get(apiRoutes.modules.tenantModules()),
};

export const featureService = {
    getAll: () => api.get(apiRoutes.features.collection()),
    toggle: (id: number, isEnabled: boolean) =>
        api.post(apiRoutes.features.toggle(id), { is_enabled: isEnabled }),
    getTenantFeatures: () => api.get(apiRoutes.features.tenantFeatures()),
    checkFeature: (feature: string) => api.get(apiRoutes.features.check(feature)),
};

export const tenantAdminService = {
    getAll: (params?: Record<string, any>) => api.get(apiRoutes.tenants.collection(params)),
    getById: (id: number) => api.get(apiRoutes.tenants.byId(id)),
    create: (data: any) => api.post(apiRoutes.tenants.collection(), data),
    update: (id: number, data: any) => api.put(apiRoutes.tenants.byId(id), data),
    delete: (id: number) => api.delete(apiRoutes.tenants.byId(id)),
    toggleStatus: (id: number, status: number) =>
        api.post(apiRoutes.tenants.toggleStatus(id), { status }),
    getStats: () => api.get(apiRoutes.tenants.stats()),
};

export const userService = {
    getAll: (params?: Record<string, any>) => api.get(apiRoutes.users.collection(params)),
    getById: (id: number) => api.get(apiRoutes.users.byId(id)),
    create: (data: any) => api.post(apiRoutes.users.collection(), data),
    update: (id: number, data: any) => api.put(apiRoutes.users.byId(id), data),
    delete: (id: number) => api.delete(apiRoutes.users.byId(id)),
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