export const LARA_LIGHT_TEAL = 'lara-light-teal';
export const LARA_DARK_TEAL = 'lara-dark-teal';

export type LaraTealTheme = typeof LARA_LIGHT_TEAL | typeof LARA_DARK_TEAL;

/** Valid saved teal theme, or system preference when missing/invalid. */
export function resolveLaraTealTheme(): LaraTealTheme {
    if (typeof window === 'undefined') {
        return LARA_LIGHT_TEAL;
    }
    const stored = localStorage.getItem('theme');
    if (stored === LARA_LIGHT_TEAL || stored === LARA_DARK_TEAL) {
        return stored;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? LARA_DARK_TEAL : LARA_LIGHT_TEAL;
}

export function themeToColorScheme(theme: LaraTealTheme): 'light' | 'dark' {
    return theme === LARA_DARK_TEAL ? 'dark' : 'light';
}
