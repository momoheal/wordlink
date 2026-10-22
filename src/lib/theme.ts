// Shared by the root layout (server) and ThemeContext (client). Kept out of the 'use client'
// module: a server component importing a constant from one gets a client reference, not the value.

export type Theme = 'dark' | 'light';

/** Cookie read by the root layout so the first paint already has the right theme. */
export const THEME_COOKIE = 'wl-theme';
