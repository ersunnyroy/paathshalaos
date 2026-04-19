'use client';

import { useEffect } from 'react';
import { PrimeReactProvider } from 'primereact/api';
import 'primereact/resources/primereact.css';
import 'primeflex/primeflex.css';
import 'primeicons/primeicons.css';
import '@/styles/layout/layout.scss';
import '@/styles/demo/Demos.scss';
import { resolveLaraTealTheme } from '@/lib/themePreference';

export default function TemplatesLayout({ children }: { children: React.ReactNode }) {
    useEffect(() => {
        const theme = resolveLaraTealTheme();
        const link = document.getElementById('theme-css') as HTMLLinkElement;
        if (link) {
            link.href = `/themes/${theme}/theme.css`;
        }
    }, []);

    return (
        <PrimeReactProvider>
            {children}
        </PrimeReactProvider>
    );
}