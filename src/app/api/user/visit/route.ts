import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ensureLocalUser, getSession } from '@/lib/auth';

// 与 src/lib/telemetry.ts 的上限一致；服务器再夹一次，接口可以被直接调用
const MAX_DWELL_MS = 24 * 60 * 60 * 1000;
const MAX_AUDIO_PLAYS = 1000;
const MAX_WORD_LENGTH = 200;
const MAX_SOURCE_LENGTH = 64;

function clampInt(value: unknown, max: number): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
    return Math.min(max, Math.max(0, n));
}

/** 记录一次单词访问。telemetry 用 sendBeacon 发来停留时长、发音次数和来源，护照的听辨等指标靠它们统计 */
export async function POST(request: Request) {
    try {
        const session = await getSession();
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json().catch(() => null);
        const word = typeof body?.word === 'string' ? body.word.trim().toLowerCase().slice(0, MAX_WORD_LENGTH) : '';
        if (!word) {
            return NextResponse.json({ error: 'Missing word' }, { status: 400 });
        }
        const source = typeof body?.source === 'string' ? body.source.trim().slice(0, MAX_SOURCE_LENGTH) : '';

        await ensureLocalUser(session);
        await prisma.wordVisit.create({
            data: {
                id: crypto.randomUUID(),
                userId: session.id,
                word,
                source: source || null,
                dwellTimeMs: clampInt(body?.dwellTimeMs, MAX_DWELL_MS),
                audioPlays: clampInt(body?.audioPlays, MAX_AUDIO_PLAYS),
            },
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Visit record error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
