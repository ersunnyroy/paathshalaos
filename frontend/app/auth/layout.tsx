'use client';

import { useEffect, useState } from 'react';
import { PrimeReactProvider } from 'primereact/api';
import 'primereact/resources/primereact.css';
import 'primeflex/primeflex.css';
import 'primeicons/primeicons.css';
import '@/styles/layout/layout.scss';

interface AuthLayoutProps {
    children: React.ReactNode;
}

export default function AuthLayout({ children }: AuthLayoutProps) {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        const savedTheme = localStorage.getItem('theme');
        const theme =
            savedTheme ||
            (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'lara-dark-indigo' : 'lara-light-indigo');
        
        const link = document.getElementById('theme-css') as HTMLLinkElement;
        if (link) {
            link.href = `/themes/${theme}/theme.css`;
        }
        setMounted(true);
    }, []);

    return (
        <PrimeReactProvider>
            {children}
        </PrimeReactProvider>
    );
}