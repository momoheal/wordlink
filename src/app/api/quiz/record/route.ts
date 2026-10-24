import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ensureLocalUser, getSession } from '@/lib/auth';
import { nextMemoryState } from '@/lib/memory';

export async function POST(request: Request) {
    try {
        const session = await getSession();
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        await ensureLocalUser(session);

        const body = await request.json().catch(() => null);
        const normalizedWord = typeof body?.word === 'string' ? body.word.trim().toLowerCase().slice(0, 200) : '';
        const normalizedTestType = Number(body?.testType);
        const rawScore = Number(body?.score);

        if (!normalizedWord || !Number.isInteger(normalizedTestType) || !Number.isFinite(rawScore)) {
            return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
        }
        if (normalizedTestType < 0 || normalizedTestType > 100) {
            return NextResponse.json({ error: 'Invalid testType' }, { status: 400 });
        }
        // 0 = 不会，1 = 模糊 / 看了提示，2 = 掌握。超出范围的分数会让记忆模型和护照统计失真
        const normalizedScore = Math.min(2, Math.max(0, Math.round(rawScore)));
        const userInput = typeof body?.userInput === 'string' ? body.userInput.slice(0, 200) : null;
        const timeSpentMs = Number.isFinite(body?.timeSpentMs)
            ? Math.min(60 * 60 * 1000, Math.max(0, Math.floor(body.timeSpentMs)))
            : null;

        // FIX: isCorrect was never written before (schema default `true` made
        // every record look correct). Derive it from the score instead.
        const isCorrect = normalizedScore > 0;

        await prisma.quizRecord.create({
            data: {
                id: crypto.randomUUID(),
                userId: session.id,
                word: normalizedWord,
                testType: normalizedTestType,
                score: normalizedScore,
                isCorrect,
                userInput,
                timeSpentMs,
            },
        });

        // Advance the per-word memory state machine (Ebbinghaus / SM-2 lite).
        // This keeps UserWordState alive for the Learning Passport and any
        // future memory-aware feature.
        try {
            const existing = await prisma.userWordState.findUnique({
                where: { userId_word: { userId: session.id, word: normalizedWord } },
            });
            const next = nextMemoryState(existing, normalizedScore);
            await prisma.userWordState.upsert({
                where: { userId_word: { userId: session.id, word: normalizedWord } },
                create: {
                    id: crypto.randomUUID(),
                    userId: session.id,
                    word: normalizedWord,
                    stage: next.stage,
                    memoryStrength: next.memoryStrength,
                    stability: next.stability,
                    repetitionCount: next.repetitionCount,
                    consecutiveRight: next.consecutiveRight,
                    wrongCount: next.wrongCount,
                    lastTestedAt: new Date(),
                    nextReviewAt: next.nextReviewAt,
                },
                update: {
                    stage: next.stage,
                    memoryStrength: next.memoryStrength,
                    stability: next.stability,
                    repetitionCount: next.repetitionCount,
                    consecutiveRight: next.consecutiveRight,
                    wrongCount: next.wrongCount,
                    lastTestedAt: new Date(),
                    nextReviewAt: next.nextReviewAt,
                },
            });
        } catch (memErr) {
            // Memory-state failure must never fail the quiz submission itself.
            console.error('UserWordState update failed:', memErr);
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Quiz record error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
