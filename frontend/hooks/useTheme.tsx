'use client';

import { useState, useEffect } from 'react';

type Theme = 'lara-light-indigo' | 'lara-dark-indigo';

/** Optional hook for layouts that toggle only Lara indigo light/dark (matches Sakai template). */
export function useTheme() {
    const [theme, setTheme] = useState<Theme>('lara-light-indigo');
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        const savedTheme = localStorage.getItem('theme') as Theme | null;
        if (savedTheme === 'lara-light-indigo' || savedTheme === 'lara-dark-indigo') {
            setTheme(savedTheme);
        } else {
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            setTheme(prefersDark ? 'lara-dark-indigo' : 'lara-light-indigo');
        }
        setMounted(true);
    }, []);

    const toggleTheme = () => {
        const newTheme = theme === 'lara-light-indigo' ? 'lara-dark-indigo' : 'lara-light-indigo';
        setTheme(newTheme);
        localStorage.setItem('theme', newTheme);
        const link = document.getElementById('theme-css') as HTMLLinkElement;
        if (link) {
            link.href = `/themes/${newTheme}/theme.css`;
        }
    };

    const setThemeMode = (mode: 'light' | 'dark') => {
        const newTheme = mode === 'dark' ? 'lara-dark-indigo' : 'lara-light-indigo';
        setTheme(newTheme);
        localStorage.setItem('theme', newTheme);
        const link = document.getElementById('theme-css') as HTMLLinkElement;
        if (link) {
            link.href = `/themes/${newTheme}/theme.css`;
        }
    };

    return {
        theme,
        themeMode: theme === 'lara-dark-indigo' ? 'dark' : 'light',
        mounted,
        toggleTheme,
        setThemeMode,
    };
}
