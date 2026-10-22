'use client';

import { useMemo, type CSSProperties } from 'react';
import { BookOpen, ChevronRight, FileText, Folder } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { groupLibraryItems, MODE_MESSAGE_KEY, type LibraryItem, type LibraryLevel } from '@/lib/library-groups';

interface LibraryListProps {
    items: LibraryItem[];
    onSelect: (item: LibraryItem) => void;
    /** First fetch still in flight: show placeholders instead of the empty-directory message. */
    loading?: boolean;
    /** 'touch' is the phone layout: larger type and tap targets. */
    size?: 'compact' | 'touch';
}

type Size = NonNullable<LibraryListProps['size']>;

const SIZES = {
    compact: {
        list: 'gap-2 p-3',
        empty: 'py-8',
        card: 'px-3 py-2.5',
        tile: 'size-8 rounded-lg text-[13px]',
        icon: 'size-4',
        title: 'text-sm',
        segment: 'h-7 px-3 text-xs',
    },
    touch: {
        list: 'gap-2.5 p-3',
        empty: 'py-12',
        card: 'px-4 py-3',
        tile: 'size-10 rounded-xl text-base',
        icon: 'size-5',
        title: 'text-base',
        segment: 'h-9 px-4 text-sm',
    },
} as const;

// Glyph colours use the 300 shade: the light theme mirrors shades, so it stays readable on paper.
const TINTS = {
    green: 'bg-green-500/10 text-green-300',
    blue: 'bg-blue-500/10 text-blue-300',
    purple: 'bg-purple-500/10 text-purple-300',
};

const CARD = 'rounded-xl border border-neutral-800 bg-neutral-900';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/50';
// Rounded outer ends, so the inset focus ring follows the capsule instead of being clipped by its overflow-hidden.
const SEGMENT = `${FOCUS} font-medium text-neutral-400 transition-colors first:rounded-l-full last:rounded-r-full focus-visible:ring-inset hover:bg-green-500/15 hover:text-green-300 active:bg-green-500/25`;

/** The library browser: folders, the user's own libraries, and one card per syllabus level. */
export default function LibraryList({ items, onSelect, loading = false, size = 'compact' }: LibraryListProps) {
    const t = useTranslations('wordList');
    const entries = useMemo(() => groupLibraryItems(items), [items]);
    const s = SIZES[size];

    if (entries.length === 0) {
        if (loading) {
            return (
                <ul aria-hidden className={`flex flex-col ${s.list}`}>
                    {Array.from({ length: 5 }, (_, i) => (
                        <li key={i} className={`flex animate-pulse items-center gap-3 ${CARD} ${s.card}`}>
                            <span className={`shrink-0 bg-neutral-800 ${s.tile}`} />
                            <span className="h-3.5 w-16 rounded bg-neutral-800" />
                            <span className={`ml-auto w-24 rounded-full bg-neutral-800 ${s.segment}`} />
                        </li>
                    ))}
                </ul>
            );
        }
        return <div className={`text-center text-sm text-neutral-500 ${s.empty}`}>{t('emptyDirectory')}</div>;
    }

    return (
        <ul className={`flex flex-col ${s.list}`}>
            {entries.map((entry, i) => (
                <li
                    key={entry.kind === 'level' ? entry.group.key : entry.item.path}
                    className="lib-card-in"
                    style={{ '--i': i } as CSSProperties}
                >
                    {entry.kind === 'level' ? (
                        <LevelCard group={entry.group} size={size} onSelect={onSelect} />
                    ) : (
                        <ItemRow item={entry.item} size={size} onSelect={onSelect} />
                    )}
                </li>
            ))}
        </ul>
    );
}

/** One syllabus level: the number tile, the level name and a two-way switch between its orderings. */
function LevelCard({ group, size, onSelect }: { group: LibraryLevel; size: Size; onSelect: (item: LibraryItem) => void }) {
    const t = useTranslations('wordList');
    const s = SIZES[size];
    // Level names come from the file names; only those with a translation (en) get relabelled.
    const title = t.has(`levels.${group.level}`) ? t(`levels.${group.level}`) : group.level;

    return (
        <div role="group" aria-label={title} className={`flex items-center gap-3 ${CARD} ${s.card}`}>
            <span className={`flex shrink-0 items-center justify-center font-semibold tabular-nums ${s.tile} ${TINTS.green}`}>
                {group.index}
            </span>
            {/* Wraps instead of squeezing the name when the panel is narrow or the labels are long */}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
                <span className={`min-w-14 flex-1 truncate font-medium text-neutral-200 ${s.title}`}>{title}</span>
                <div className="flex shrink-0 divide-x divide-neutral-800 overflow-hidden rounded-full border border-neutral-800 bg-black">
                    {group.variants.map(({ mode, item }) => {
                        const label = t(MODE_MESSAGE_KEY[mode]);
                        return (
                            <button
                                key={item.path}
                                type="button"
                                onClick={() => onSelect(item)}
                                aria-label={`${title} · ${label}`}
                                className={`${s.segment} ${SEGMENT}`}
                            >
                                {label}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

/** A folder, one of the user's libraries, or a file that is not part of a level pair. */
function ItemRow({ item, size, onSelect }: { item: LibraryItem; size: Size; onSelect: (item: LibraryItem) => void }) {
    const t = useTranslations('wordList');
    const s = SIZES[size];
    const isFolder = item.type === 'directory';
    const isUser = item.source === 'user';
    const Icon = isFolder ? Folder : isUser ? BookOpen : FileText;
    const tint = isFolder ? TINTS.blue : isUser ? TINTS.purple : TINTS.green;

    return (
        <button
            type="button"
            onClick={() => onSelect(item)}
            className={`group flex w-full items-center gap-3 text-left transition-colors hover:border-neutral-700 hover:bg-neutral-800/60 active:bg-neutral-800 ${CARD} ${FOCUS} ${s.card}`}
        >
            <span className={`flex shrink-0 items-center justify-center ${s.tile} ${tint}`}>
                <Icon className={s.icon} />
            </span>
            <span className="min-w-0 flex-1">
                <span className={`block truncate font-medium text-neutral-200 group-hover:text-white ${s.title}`}>
                    {item.name.replace(/\.(?:csv|txt)$/i, '')}
                </span>
                {isUser && (
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-neutral-500">
                        <span className="rounded bg-purple-500/15 px-1.5 py-px text-[11px] font-medium text-purple-300">
                            {t('myLibrary')}
                        </span>
                        {t('wordsCount', { count: item.wordCount || 0 })}
                    </span>
                )}
            </span>
            <ChevronRight className="size-4 shrink-0 text-neutral-600 transition-transform group-hover:translate-x-0.5 group-hover:text-neutral-400" />
        </button>
    );
}
