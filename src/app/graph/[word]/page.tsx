'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { BookOpen } from 'lucide-react';
import PanelFissionGraph from '@/components/PanelFissionGraph';

/** The words visited on this page, and which one is on screen. */
interface Trail { words: string[]; at: number }

const wordFromPath = (path: string) => {
    const match = path.match(/^\/graph\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
};

/**
 * The word graph on a phone, full screen: the same graph as the workspace and immersive mode. Tapping a word
 * moves the graph to it in place, so the move animates; each word still gets its own URL and history entry,
 * so the back gesture steps back through the words before it leaves the page.
 */
export default function MobileGraphPage() {
    const t = useTranslations('misc.graphPage');
    const params = useParams();
    const router = useRouter();
    const [trail, setTrail] = useState<Trail>(() => ({ words: [decodeURIComponent(params.word as string)], at: 0 }));
    const word = trail.words[trail.at];

    useEffect(() => {
        // Mark this entry as the first word, so coming back to it from a later one is recognised.
        window.history.replaceState({ graphIndex: 0 }, '');
        const onPop = (e: PopStateEvent) => {
            const shown = wordFromPath(window.location.pathname);
            if (!shown) return; // leaving the page
            // The URL decides which word is shown; the trail only knows where it sits among the visited ones.
            const index = (e.state as { graphIndex?: unknown } | null)?.graphIndex;
            setTrail((prev) => (typeof index === 'number' && prev.words[index] === shown
                ? { ...prev, at: index }
                : { words: [shown], at: 0 }));
        };
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);

    const go = (next: string) => {
        if (next === word) return;
        const at = trail.at + 1;
        setTrail({ words: [...trail.words.slice(0, at), next], at });
        // Only our own data: Next.js adds its router state and keeps its URL in sync, without a navigation.
        window.history.pushState({ graphIndex: at }, '', `/graph/${encodeURIComponent(next)}`);
    };

    const back = () => {
        // Opened straight on this page (a shared link, a new tab): there is no page to go back to, so go up to
        // the word's own page instead.
        if (trail.at === 0 && window.history.length <= 1) router.push(`/word/${encodeURIComponent(word)}`);
        else router.back();
    };

    return (
        <div className="relative flex h-dvh w-screen flex-col overflow-hidden bg-neutral-950 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
            <div className="relative min-h-0 flex-1">
                <PanelFissionGraph
                    word={word}
                    onNodeClick={go}
                    onBack={back}
                    backTo={trail.at > 0 ? trail.words[trail.at - 1] : null}
                    actions={
                        <Link
                            href={`/word/${encodeURIComponent(word)}`}
                            className="inline-flex items-center gap-1 rounded border border-neutral-800 px-2 py-1 text-[11px] leading-none text-neutral-300 transition-colors hover:bg-neutral-800 pointer-coarse:px-3 pointer-coarse:py-2"
                        >
                            <BookOpen size={12} />
                            {t('details')}
                        </Link>
                    }
                />
            </div>
        </div>
    );
}
