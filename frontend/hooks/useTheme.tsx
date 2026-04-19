'use client';

import { useState, useEffect } from 'react';
import { LARA_DARK_TEAL, LARA_LIGHT_TEAL, LaraTealTheme, resolveLaraTealTheme } from '@/lib/themePreference';

/** Lara teal light/dark only; matches top bar toggle and {@link localStorage} key `theme`. */
export function useTheme() {
    const [theme, setTheme] = useState<LaraTealTheme>(LARA_LIGHT_TEAL);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setTheme(resolveLaraTealTheme());
        setMounted(true);
    }, []);

    const toggleTheme = () => {
        const newTheme = theme === LARA_LIGHT_TEAL ? LARA_DARK_TEAL : LARA_LIGHT_TEAL;
        setTheme(newTheme);
        localStorage.setItem('theme', newTheme);
        const link = document.getElementById('theme-css') as HTMLLinkElement;
        if (link) {
            link.href = `/themes/${newTheme}/theme.css`;
        }
    };

    const setThemeMode = (mode: 'light' | 'dark') => {
        const newTheme = mode === 'dark' ? LARA_DARK_TEAL : LARA_LIGHT_TEAL;
        setTheme(newTheme);
        localStorage.setItem('theme', newTheme);
        const link = document.getElementById('theme-css') as HTMLLinkElement;
        if (link) {
            link.href = `/themes/${newTheme}/theme.css`;
        }
    };

    return {
        theme,
        themeMode: theme === LARA_DARK_TEAL ? 'dark' : 'light',
        mounted,
        toggleTheme,
        setThemeMode,
    };
}
