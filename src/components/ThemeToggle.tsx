'use client';

import { Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useTheme } from '@/context/ThemeContext';

/** Sun/moon button that flips the global light/dark theme. */
export default function ThemeToggle({ className = '', size = 16 }: { className?: string; size?: number }) {
    const { theme, toggleTheme } = useTheme();
    const t = useTranslations('theme');
    const label = theme === 'dark' ? t('switchToLight') : t('switchToDark');
    return (
        <button type="button" onClick={toggleTheme} title={label} aria-label={label} className={className}>
            {theme === 'dark' ? <Sun size={size} strokeWidth={1.8} /> : <Moon size={size} strokeWidth={1.8} />}
        </button>
    );
}
