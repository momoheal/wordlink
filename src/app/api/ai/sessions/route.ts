import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ensureLocalUser, getSession } from '@/lib/auth';

/** 侧栏最多列出的会话数 */
const SESSION_LIMIT = 50;

/** GET /api/ai/sessions —— 会话列表（不含消息正文，打开某个会话时再取 /api/ai/sessions/[id]） */
export async function GET() {
    try {
        const session = await getSession();
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        await ensureLocalUser(session);

        const sessions = await prisma.chat_sessions.findMany({
            where: { userId: session.id },
            orderBy: { updatedAt: 'desc' },
            take: SESSION_LIMIT,
            select: {
                id: true,
                title: true,
                category: true,
                word: true,
                wordGroup: true,
                createdAt: true,
                updatedAt: true,
                _count: { select: { chat_messages: true } },
            },
        });
        return NextResponse.json(sessions.map(({ _count, ...s }) => ({ ...s, messageCount: _count.chat_messages })));
    } catch (error) {
        console.error('Failed to fetch sessions:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
