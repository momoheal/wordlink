import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { clientIp, rateLimit, tooManyRequests } from '@/lib/rate-limit';

export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => null);
        const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';

        if (!email) {
            return NextResponse.json({ error: 'Missing email address' }, { status: 400 });
        }

        // 每次请求都会给这个邮箱发信：同一邮箱 10 分钟 3 封、同一 IP 10 分钟 5 次，防止拿它轰炸别人的邮箱
        const perEmail = rateLimit(`mail-email:${email}`, 3, 10 * 60_000);
        if (!perEmail.ok) return tooManyRequests(perEmail.retryAfterSec);
        const perIp = rateLimit(`mail-ip:${clientIp(request)}`, 5, 10 * 60_000);
        if (!perIp.ok) return tooManyRequests(perIp.retryAfterSec);

        const origin = request.headers.get('origin') || process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
        const supabase = await createClient();
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${origin}/auth/callback?next=/reset-password`,
        });

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }

        return NextResponse.json({
            success: true,
            message: 'Password reset link has been sent to your email.',
        });
    } catch (error) {
        console.error('Forgot password error:', error);
        const message = error instanceof Error ? error.message : 'Failed to process request';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
