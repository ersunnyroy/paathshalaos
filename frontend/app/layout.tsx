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

function RootLayoutInner({ children }: RootLayoutProps) {
    const { layoutConfig } = useContext(LayoutContext);
    const [tenant, setTenant] = useState<TenantInfo | null>(null);
    const [tenantLoading, setTenantLoading] = useState(true);

    const isMultiTenant = tenantService.isMultiTenant();

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
        } else if (!tenantService.isMultiTenant()) {
            setTenantLoading(false);
        } else {
            fetchTenant();
        }
    }, []);

    useEffect(() => {
        if (tenant) {
            document.title = tenant.name || 'PaathshalaOS';
            if (tenant.favicon_url) {
                let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
                if (!link) {
                    link = document.createElement('link');
                    link.rel = 'icon';
                    document.head.appendChild(link);
                }
                link.href = tenant.favicon_url;
            }
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
