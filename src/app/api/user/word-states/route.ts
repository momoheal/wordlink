import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth';
import type { Familiarity } from '@/lib/graph-shared';

const MAX_WORDS = 400;

function familiarityFor(stage: string): Familiarity {
    if (stage === 'MASTERED') return 'mastered';
    if (stage === 'UNFAMILIAR') return 'weak';
    return 'learning';
}

/**
 * POST /api/user/word-states { words: string[] }
 * -> { states: { [word]: 'seen' | 'weak' | 'learning' | 'mastered' } }
 *
 * Familiarity for colouring graph nodes. Words the user never opened are omitted ("new");
 * guests get an empty map.
 */
export async function POST(request: Request) {
    const session = await getSession();
    if (!session) return NextResponse.json({ states: {} });

    const body = await request.json().catch(() => null) as { words?: unknown } | null;
    const words = Array.isArray(body?.words)
        ? [...new Set(body.words.filter((w): w is string => typeof w === 'string').map((w) => w.trim().toLowerCase()).filter(Boolean))].slice(0, MAX_WORDS)
        : [];
    if (words.length === 0) return NextResponse.json({ states: {} });

    try {
        const [memory, visits] = await Promise.all([
            prisma.userWordState.findMany({
                where: { userId: session.id, word: { in: words } },
                select: { word: true, stage: true },
            }),
            prisma.wordVisit.findMany({
                where: { userId: session.id, word: { in: words } },
                select: { word: true },
                distinct: ['word'],
            }),
        ]);

        const states: Record<string, Familiarity> = {};
        for (const v of visits) states[v.word] = 'seen';
        for (const m of memory) states[m.word] = familiarityFor(m.stage);
        return NextResponse.json({ states });
    } catch (error) {
        console.error('word-states error:', error);
        return NextResponse.json({ states: {} });
    }
}
