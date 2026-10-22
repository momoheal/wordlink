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

// aiChat 直接数 chat_messages（经 chat_sessions 归属到用户）；ambientGenerate 走
// UsageLog（AmbientArticle 是全局共享文章库，无用户归属字段），由 generate 路由
// 在成功响应前写入。
export async function checkDailyQuota(userId: string, kind: QuotaKind): Promise<DailyQuota> {
    const limit = FREE_DAILY_LIMITS[kind];
    const since = startOfToday();
    const used =
        kind === 'aiChat'
            ? await prisma.chat_messages.count({
                  where: {
                      role: 'user',
                      createdAt: { gte: since },
                      chat_sessions: { userId },
                  },
              })
            : await prisma.usageLog.count({
                  where: { userId, kind, createdAt: { gte: since } },
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
