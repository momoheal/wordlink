'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { THEME_COOKIE, type Theme } from '@/lib/theme';

export type { Theme };

interface ThemeContextValue {
    theme: Theme;
    setTheme: (theme: Theme) => void;
    toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ initialTheme, children }: { initialTheme: Theme; children: React.ReactNode }) {
    const [theme, setThemeState] = useState<Theme>(initialTheme);

    const setTheme = useCallback((next: Theme) => {
        setThemeState(next);
        document.documentElement.dataset.theme = next;
        document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
        window.dispatchEvent(new CustomEvent('theme-changed', { detail: next }));
    }, []);

    const toggleTheme = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [theme, setTheme]);

    // Another tab may have switched the theme; pick it up when this one regains focus.
    useEffect(() => {
        const syncFromCookie = () => {
            const match = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=(dark|light)`));
            if (match && match[1] !== theme) {
                setThemeState(match[1] as Theme);
                document.documentElement.dataset.theme = match[1];
            }
        };
        window.addEventListener('focus', syncFromCookie);
        return () => window.removeEventListener('focus', syncFromCookie);
    }, [theme]);

    return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
    return ctx;
}
