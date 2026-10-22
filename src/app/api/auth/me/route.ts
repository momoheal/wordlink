import { NextResponse } from 'next/server';
import { getSession, isPro } from '@/lib/auth';
import { checkDailyQuota, FREE_DAILY_LIMITS } from '@/lib/quota';
import { isAlipayConfigured } from '@/lib/pay/alipay';

const EMPTY_USAGE = {
    aiChat: { used: 0, limit: FREE_DAILY_LIMITS.aiChat },
    ambientGenerate: { used: 0, limit: FREE_DAILY_LIMITS.ambientGenerate },
};

export async function GET() {
    try {
        const user = await getSession();
        const usage = { ...EMPTY_USAGE };
        if (user) {
            const [chat, ambient] = await Promise.all([
                checkDailyQuota(user.id, 'aiChat').catch(() => null),
                checkDailyQuota(user.id, 'ambientGenerate').catch(() => null),
            ]);
            usage.aiChat = { used: chat?.used ?? 0, limit: FREE_DAILY_LIMITS.aiChat };
            usage.ambientGenerate = { used: ambient?.used ?? 0, limit: FREE_DAILY_LIMITS.ambientGenerate };
        }
        return NextResponse.json({
            user: user ? { ...user, isPro: isPro(user) } : null,
            usage,
            payConfigured: isAlipayConfigured(),
        });
    } catch {
        return NextResponse.json({ user: null, usage: EMPTY_USAGE, payConfigured: false });
    }
}
