'use client';

import { useEffect, useState, useContext } from 'react';
import { LayoutProvider } from '../layout/context/layoutcontext';
import { LayoutContext } from '../layout/context/layoutcontext';
import { PrimeReactProvider } from 'primereact/api';
import 'primereact/resources/primereact.css';
import 'primeflex/primeflex.css';
import 'primeicons/primeicons.css';
import '../styles/layout/layout.scss';
import '../styles/demo/Demos.scss';
import { tenantService, TenantInfo } from '@/services/tenant';
import { TenantContext } from '@/services/api';

interface RootLayoutProps {
    children: React.ReactNode;
}

function getCurrentSubdomain(): string | null {
    if (typeof window === 'undefined') return null;
    const host = window.location.host;

    if (host.includes('localhost') || host.includes('paathshala.local')) {
        const parts = host.split('.')[0];
        if (parts === 'localhost' || parts === 'paathshala') {
            return null;
        }
        if (host.includes('paathshala.local')) {
            return parts;
        }
        return null;
    }

    const baseDomain = 'paathshala.local';
    if (host.endsWith(baseDomain)) {
        const subdomain = host.replace('.' + baseDomain, '').replace(baseDomain, '').replace('://', '').split('.')[0];
        return subdomain || null;
    }

    return null;
}

function RootLayoutInner({ children }: RootLayoutProps) {
    const { layoutConfig } = useContext(LayoutContext);
    const [tenant, setTenant] = useState<TenantInfo | null>(null);
    const [tenantLoading, setTenantLoading] = useState(true);

    const isMultiTenant = getCurrentSubdomain() !== null;

    const fetchTenant = async () => {
        setTenantLoading(true);
        try {
            const tenantData = await tenantService.fetch();
            setTenant(tenantData);
        } catch (error) {
            console.error('Error fetching tenant:', error);
            setTenant(null);
        } finally {
            setTenantLoading(false);
        }
    };

    useEffect(() => {
        const stored = tenantService.getTenant();
        if (stored) {
            setTenant(stored);
            setTenantLoading(false);
        } else {
            if (!getCurrentSubdomain()) {
                setTenantLoading(false);
            } else {
                fetchTenant();
            }
        }
    }, []);

    useEffect(() => {
        if (tenant) {
            document.title = tenant.name || 'PaathshalaOS';
        } else {
            document.title = 'PaathshalaOS';
        }
    }, [tenant]);

    useEffect(() => {
        const link = document.getElementById('theme-css') as HTMLLinkElement | null;
        if (link) {
            link.href = `/themes/${layoutConfig.theme}/theme.css`;
        }
    }, [layoutConfig.theme]);

    useEffect(() => {
        let lastHostname = typeof window !== 'undefined' ? window.location.hostname : '';

        const checkDomainChange = () => {
            if (typeof window === 'undefined') return;
            const currentHostname = window.location.hostname;
            if (currentHostname !== lastHostname) {
                lastHostname = currentHostname;
                tenantService.resetForNewDomain();
                window.location.reload();
            }
        };

        const interval = setInterval(checkDomainChange, 2000);
        return () => clearInterval(interval);
    }, []);

    return (
        <TenantContext.Provider value={{ tenant, loading: tenantLoading, isMultiTenant, refreshTenant: fetchTenant }}>
            {children}
        </TenantContext.Provider>
    );
}

export default function RootLayout({ children }: RootLayoutProps) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <link id="theme-css" href="/themes/lara-light-teal/theme.css" rel="stylesheet" />
            </head>
            <body>
                <PrimeReactProvider>
                    <LayoutProvider>
                        <RootLayoutInner>{children}</RootLayoutInner>
                    </LayoutProvider>
                </PrimeReactProvider>
            </body>
        </html>
    );
}
