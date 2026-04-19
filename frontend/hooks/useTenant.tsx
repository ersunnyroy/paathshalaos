'use client';

import { useEffect, useState, createContext, useContext, ReactNode } from 'react';
import { tenantService, TenantInfo } from '@/services/tenant';

interface TenantContextType {
    tenant: TenantInfo | null;
    loading: boolean;
    isMultiTenant: boolean;
    refreshTenant: () => Promise<void>;
}

const TenantContext = createContext<TenantContextType>({
    tenant: null,
    loading: true,
    isMultiTenant: false,
    refreshTenant: async () => {},
});

export function useTenant() {
    return useContext(TenantContext);
}

interface TenantProviderProps {
    children: ReactNode;
}

export function TenantProvider({ children }: TenantProviderProps) {
    const [tenant, setTenant] = useState<TenantInfo | null>(null);
    const [loading, setLoading] = useState(true);

    const isMultiTenant = tenantService.isMultiTenant();

    const fetchTenant = async () => {
        setLoading(true);
        try {
            const tenantData = await tenantService.fetch();
            setTenant(tenantData);
        } catch (error) {
            console.error('Error fetching tenant:', error);
            setTenant(null);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        const stored = tenantService.getTenant();
        if (stored) {
            setTenant(stored);
            setLoading(false);
        } else {
            fetchTenant();
        }
    }, []);

    useEffect(() => {
        if (tenant) {
            document.title = tenant.name || 'PaathshalaOS';
            if (tenant.primary_color) {
                document.documentElement.style.setProperty('--primary-color', tenant.primary_color);
            }
        }
    }, [tenant]);

    return (
        <TenantContext.Provider value={{ tenant, loading, isMultiTenant, refreshTenant: fetchTenant }}>
            {children}
        </TenantContext.Provider>
    );
}

let lastHostname = typeof window !== 'undefined' ? window.location.hostname : '';

export function initTenantDetection() {
    if (typeof window === 'undefined') return;

    const checkDomainChange = () => {
        const currentHostname = window.location.hostname;
        if (currentHostname !== lastHostname) {
            lastHostname = currentHostname;
            tenantService.resetForNewDomain();
            window.location.reload();
        }
    };

    setInterval(checkDomainChange, 1000);
}