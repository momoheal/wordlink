// The word-library browser lists the files of a directory. The bundled syllabus files are named
// "<n>-<level>-<order>" (3-CET4-乱序.csv, 3-CET4-顺序.csv): two orderings of the same word list. The
// browser shows one card per level instead of one row per file, so the pair is grouped here.
// Pure and client-safe — `data.ts` (fs) stays server-only.

export interface LibraryItem {
    name: string;
    type: 'file' | 'directory';
    path: string;
    source?: 'system' | 'user';
    libraryId?: string;
    wordCount?: number;
}

export type LibraryMode = 'sequential' | 'shuffled';

export interface LibraryLevel {
    /** "3-CET4": stable React key */
    key: string;
    /** Numeric prefix of the file name ("3"): the level's rank in the syllabus */
    index: string;
    /** Level token as written in the file name ("CET4") */
    level: string;
    variants: { mode: LibraryMode; item: LibraryItem }[];
}

export type LibraryEntry =
    | { kind: 'level'; group: LibraryLevel }
    | { kind: 'item'; item: LibraryItem };

const LEVEL_FILE = /^(\d+)-(.+)-(顺序|乱序)\.(?:csv|txt)$/i;
const MODE_BY_SUFFIX: Record<string, LibraryMode> = { 顺序: 'sequential', 乱序: 'shuffled' };
// The API sorts by name, which puts 乱序 before 顺序; the card always reads in-order first.
const MODE_RANK: Record<LibraryMode, number> = { sequential: 0, shuffled: 1 };

/**
 * Folds the "<n>-<level>-<order>" pairs of a directory listing into one entry per level, kept at the
 * position of the pair's first file. Anything else (folders, user libraries, other file names) passes
 * through as a plain item.
 */
export function groupLibraryItems(items: LibraryItem[]): LibraryEntry[] {
    const entries: LibraryEntry[] = [];
    const levels = new Map<string, LibraryLevel>();

    for (const item of items) {
        const match = item.type === 'file' && item.source !== 'user' ? LEVEL_FILE.exec(item.name) : null;
        if (!match) {
            entries.push({ kind: 'item', item });
            continue;
        }

        const [, index, level, suffix] = match;
        const key = `${index}-${level}`;
        let group = levels.get(key);
        if (!group) {
            group = { key, index, level, variants: [] };
            levels.set(key, group);
            entries.push({ kind: 'level', group });
        }
        group.variants.push({ mode: MODE_BY_SUFFIX[suffix], item });
    }

    for (const group of levels.values()) {
        group.variants.sort((a, b) => MODE_RANK[a.mode] - MODE_RANK[b.mode]);
    }
    return entries;
}
