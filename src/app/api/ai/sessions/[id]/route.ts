import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth';

/** 打开会话时最多取的消息条数（最新的这些） */
const MESSAGE_LIMIT = 200;

/** GET /api/ai/sessions/[id] —— 一个会话的消息记录，按时间正序；只能看自己的会话 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getSession();
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id } = await params;
        const chat = await prisma.chat_sessions.findFirst({
            where: { id, userId: session.id },
            select: {
                id: true,
                title: true,
                category: true,
                word: true,
                wordGroup: true,
                createdAt: true,
                updatedAt: true,
                chat_messages: {
                    orderBy: { createdAt: 'desc' },
                    take: MESSAGE_LIMIT,
                    select: { id: true, role: true, content: true, createdAt: true },
                },
            },
        });
        if (!chat) {
            return NextResponse.json({ error: 'Session not found' }, { status: 404 });
        }

        const { chat_messages, ...rest } = chat;
        return NextResponse.json({ ...rest, messages: chat_messages.reverse() });
    } catch (error) {
        console.error('Failed to fetch chat session:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

/** DELETE /api/ai/sessions/[id] —— 删除自己的会话，消息随之级联删除 */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getSession();
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id } = await params;
        const { count } = await prisma.chat_sessions.deleteMany({ where: { id, userId: session.id } });
        if (count === 0) {
            return NextResponse.json({ error: 'Session not found' }, { status: 404 });
        }
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Failed to delete chat session:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
