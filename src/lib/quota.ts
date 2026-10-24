import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export type QuotaKind = 'aiChat' | 'ambientGenerate';

function envLimit(name: string, fallback: number): number {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

// 免费用户每日额度，Pro 用户不受限
export const FREE_DAILY_LIMITS: Record<QuotaKind, number> = {
    aiChat: envLimit('AI_CHAT_FREE_DAILY_LIMIT', 20),
    ambientGenerate: envLimit('AMBIENT_FREE_DAILY_LIMIT', 3),
};

function startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

export interface DailyQuota {
    allowed: boolean;
    used: number;
    limit: number;
}

// 两种额度都数 UsageLog：由各自的路由在上游模型接受请求之后写入。
// aiChat 不能直接数 chat_messages——用户删掉会话，消息跟着级联删除，额度就被「退」回来了。
export async function checkDailyQuota(userId: string, kind: QuotaKind): Promise<DailyQuota> {
    const limit = FREE_DAILY_LIMITS[kind];
    const used = await prisma.usageLog.count({
        where: { userId, kind, createdAt: { gte: startOfToday() } },
    });
    return { allowed: used < limit, used, limit };
}

export async function recordUsage(userId: string, kind: QuotaKind): Promise<void> {
    await prisma.usageLog.create({ data: { userId, kind } });
}

export function quotaExceededResponse(quota: DailyQuota, kind: QuotaKind): NextResponse {
    return NextResponse.json(
        { code: 'QUOTA_EXCEEDED', kind, used: quota.used, limit: quota.limit },
        { status: 402 },
    );
}
