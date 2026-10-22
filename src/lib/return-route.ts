// Where the ambient screen returns to: the page it was opened from (the study workspace, a reading page,
// the home page...), instead of always the home page.

const STORAGE_KEY = 'wl-return-to';
/** Pages not worth returning to. */
const SKIPPED = ['/ambient', '/login', '/reset-password', '/auth'];

const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
const pathnameOf = (path: string) => path.split(/[?#]/)[0];

let lastPath: string | null = null;
/** The page the ambient screen was opened from by an in-app navigation; null after a fresh page load. */
let openedFrom: string | null = null;
const listeners = new Set<() => void>();

/** Call on every route change: remembers the page, and where the ambient screen was opened from. */
export function trackRoute(path: string) {
    const pathname = pathnameOf(path);
    if (isUnder(pathname, '/ambient')) {
        if (lastPath && !isUnder(pathnameOf(lastPath), '/ambient')) openedFrom = lastPath;
    } else {
        openedFrom = null;
        if (!SKIPPED.some((p) => isUnder(pathname, p))) {
            try { sessionStorage.setItem(STORAGE_KEY, path); } catch { /* storage unavailable: fall back to home */ }
        }
    }
    lastPath = path;
    listeners.forEach((notify) => notify());
}

export function subscribeReturnRoute(notify: () => void) {
    listeners.add(notify);
    return () => { listeners.delete(notify); };
}

/** The page leaving the ambient screen goes to; null when there is none to go back to. */
export function returnRoute(): string | null {
    if (openedFrom) return openedFrom;
    try { return sessionStorage.getItem(STORAGE_KEY); } catch { return null; }
}

/** Leaves the ambient screen: steps back when it was opened from a page of the app, else goes to that page (or home). */
export function leaveAmbient(router: { back(): void; push(href: string): void }) {
    if (openedFrom) router.back();
    else router.push(returnRoute() ?? '/home');
}
