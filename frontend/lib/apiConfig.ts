export const API_BASE_URL = '/api';

type ApiEndpoint = string | ((id: number) => string);
type ListEndpoint = string | ((params?: Record<string, string | number>) => string);

interface ApiConfig {
  auth: {
    login: string;
    logout: string;
    register: string;
    me: string;
    refresh: string;
    forgotPassword: string;
    resetPassword: string;
    changePassword: string;
    tenant: string;
    branches: string;
  };
  tenants: {
    list: string;
    create: string;
    show: ApiEndpoint;
    update: ApiEndpoint;
    delete: ApiEndpoint;
    stats: string;
    checkSubdomain: string;
    uploadLogo: ApiEndpoint;
    toggleStatus: ApiEndpoint;
  };
  users: {
    list: ListEndpoint;
    create: string;
    show: ApiEndpoint;
    update: ApiEndpoint;
    delete: ApiEndpoint;
  };
  branches: {
    list: ListEndpoint;
    create: string;
    show: ApiEndpoint;
    update: ApiEndpoint;
    delete: ApiEndpoint;
  };
  roles: {
    list: ListEndpoint;
    create: string;
    show: ApiEndpoint;
    update: ApiEndpoint;
    delete: ApiEndpoint;
    permissions: ApiEndpoint;
  };
  modules: {
    list: string;
    tenantModules: string;
    toggle: ApiEndpoint;
  };
  features: {
    list: string;
    tenantFeatures: string;
    check: string;
    toggle: ApiEndpoint;
  };
  permissions: {
    list: string;
  };
  plans: {
    list: string;
    show: ApiEndpoint;
  };
  emailTemplates: {
    list: string;
    create: string;
    show: ApiEndpoint;
    update: ApiEndpoint;
    delete: ApiEndpoint;
    activate: ApiEndpoint;
    deactivate: ApiEndpoint;
  };
  references: {
    countries: string;
    states: string;
    instituteTypes: string;
    boards: string;
    mediums: string;
  };
}

export const API: ApiConfig = {
  auth: {
    login: `${API_BASE_URL}/auth/login`,
    logout: `${API_BASE_URL}/auth/logout`,
    register: `${API_BASE_URL}/auth/register`,
    me: `${API_BASE_URL}/auth/me`,
    refresh: `${API_BASE_URL}/auth/refresh`,
    forgotPassword: `${API_BASE_URL}/auth/forgot-password`,
    resetPassword: `${API_BASE_URL}/auth/reset-password`,
    changePassword: `${API_BASE_URL}/auth/change-password`,
    tenant: `${API_BASE_URL}/auth/tenant`,
    branches: `${API_BASE_URL}/auth/branches`,
  },
  tenants: {
    list: `${API_BASE_URL}/tenants`,
    create: `${API_BASE_URL}/tenants`,
    show: (id: number) => `${API_BASE_URL}/tenants/${id}`,
    update: (id: number) => `${API_BASE_URL}/tenants/${id}`,
    delete: (id: number) => `${API_BASE_URL}/tenants/${id}`,
    stats: `${API_BASE_URL}/tenants/stats`,
    checkSubdomain: `${API_BASE_URL}/tenants/check-subdomain`,
    uploadLogo: (id: number) => `${API_BASE_URL}/tenants/${id}/logo`,
    toggleStatus: (id: number) => `${API_BASE_URL}/tenants/${id}/toggle-status`,
  },
  users: {
    list: (params?: Record<string, string | number>) => {
        const base = `${API_BASE_URL}/users`;
        if (params) {
            const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
            return query ? `${base}?${query}` : base;
        }
        return base;
    },
    create: `${API_BASE_URL}/users`,
    show: (id: number) => `${API_BASE_URL}/users/${id}`,
    update: (id: number) => `${API_BASE_URL}/users/${id}`,
    delete: (id: number) => `${API_BASE_URL}/users/${id}`,
  },
  branches: {
    list: (params?: Record<string, string | number>) => {
        const base = `${API_BASE_URL}/branches`;
        if (params) {
            const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
            return query ? `${base}?${query}` : base;
        }
        return base;
    },
    create: `${API_BASE_URL}/branches`,
    show: (id: number) => `${API_BASE_URL}/branches/${id}`,
    update: (id: number) => `${API_BASE_URL}/branches/${id}`,
    delete: (id: number) => `${API_BASE_URL}/branches/${id}`,
  },
  roles: {
    list: (params?: Record<string, string | number>) => {
        const base = `${API_BASE_URL}/roles`;
        if (params) {
            const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
            return query ? `${base}?${query}` : base;
        }
        return base;
    },
    create: `${API_BASE_URL}/roles`,
    show: (id: number) => `${API_BASE_URL}/roles/${id}`,
    update: (id: number) => `${API_BASE_URL}/roles/${id}`,
    delete: (id: number) => `${API_BASE_URL}/roles/${id}`,
    permissions: (id: number) => `${API_BASE_URL}/roles/${id}/permissions`,
  },
  modules: {
    list: `${API_BASE_URL}/modules`,
    tenantModules: `${API_BASE_URL}/tenant/modules`,
    toggle: (id: number) => `${API_BASE_URL}/modules/${id}/toggle`,
  },
  features: {
    list: `${API_BASE_URL}/features`,
    tenantFeatures: `${API_BASE_URL}/tenant/features`,
    check: `${API_BASE_URL}/check-feature`,
    toggle: (id: number) => `${API_BASE_URL}/features/${id}/toggle`,
  },
  permissions: {
    list: `${API_BASE_URL}/permissions`,
  },
  plans: {
    list: `${API_BASE_URL}/plans`,
    show: (id: number) => `${API_BASE_URL}/plans/${id}`,
  },
  emailTemplates: {
    list: `${API_BASE_URL}/email-templates`,
    create: `${API_BASE_URL}/email-templates`,
    show: (id: number) => `${API_BASE_URL}/email-templates/${id}`,
    update: (id: number) => `${API_BASE_URL}/email-templates/${id}`,
    delete: (id: number) => `${API_BASE_URL}/email-templates/${id}`,
    activate: (id: number) => `${API_BASE_URL}/email-templates/${id}/activate`,
    deactivate: (id: number) => `${API_BASE_URL}/email-templates/${id}/deactivate`,
  },
  references: {
    countries: `${API_BASE_URL}/references/countries`,
    states: `${API_BASE_URL}/references/states`,
    instituteTypes: `${API_BASE_URL}/references/institute-types`,
    boards: `${API_BASE_URL}/references/boards`,
    mediums: `${API_BASE_URL}/references/mediums`,
  },
};

export const getApiUrl = (section: string, key?: string): string => {
  if (key && API[section as keyof typeof API]) {
    const endpoints = API[section as keyof typeof API] as Record<string, string>;
    return endpoints[key] || '';
  }
  return '';
};

export default API_BASE_URL;