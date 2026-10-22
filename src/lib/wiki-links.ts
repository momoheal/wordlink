// The dictionary markdown links related words as [[word]]. The word detail views render them as
// in-page anchors (#word) and intercept the click.

/** `[[give up]]` → `[give up](<#give up>)`; the angle brackets keep multi-word targets parseable. */
export function wikiLinksToMarkdown(content: string): string {
    return content.replace(/\[\[(.*?)\]\]/g, (_match, linked: string) => `[${linked}](<#${linked}>)`);
}

/** The word a `#word` anchor points to. Rendered hrefs come back percent-encoded (`#give%20up`). */
export function wordFromHref(href: string | null | undefined): string | null {
    if (!href?.startsWith('#') || href.length < 2) return null;
    try {
        return decodeURIComponent(href.slice(1));
    } catch {
        return href.slice(1);
    }
}
