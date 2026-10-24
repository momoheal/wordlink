/**
 * 把来自 URL 参数的跳转目标收窄成站内路径，否则返回 fallback（前后端都可用）。
 * 只看前缀不够：浏览器把 "/\evil.com" 和 "/<Tab>/evil.com" 都解析成 //evil.com，跳到外站。
 * 这里按浏览器的规则解析一遍，确认仍在本站，并返回解析后的路径。
 */
export function safeReturnPath(value: string | null | undefined, fallback = '/home'): string {
    if (!value || !value.startsWith('/')) return fallback;
    try {
        const base = 'http://localhost';
        const url = new URL(value, base);
        if (url.origin !== base) return fallback;
        return `${url.pathname}${url.search}${url.hash}`;
    } catch {
        return fallback;
    }
}
