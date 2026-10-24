import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth';

/**
 * GET /api/ai/context —— AI 助手开场白里「我已获取你的学习数据」用到的计数。
 * 学习数据本身由 /api/ai/chat 在服务器端按会话模式取用，不经过浏览器。
 */
export async function GET() {
    try {
        const session = await getSession();
        if (!session) {
            return NextResponse.json({ historyCount: 0, testCount: 0 });
        }

        const [historyCount, testCount] = await Promise.all([
            prisma.wordVisit.count({ where: { userId: session.id } }),
            prisma.quizRecord.count({ where: { userId: session.id } }),
        ]);
        return NextResponse.json({ historyCount, testCount });
    } catch (error) {
        console.error('AI context API error:', error);
        return NextResponse.json({ historyCount: 0, testCount: 0, error: 'Failed to fetch context' });
    }
}
