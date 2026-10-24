import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth';
import { clientIp, rateLimit, tooManyRequests } from '@/lib/rate-limit';

export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => null);
        const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
        const password = typeof body?.password === 'string' ? body.password : '';

        if (!email || !password) {
            return NextResponse.json({ error: 'Missing email or password' }, { status: 400 });
        }

        // 撞库防护：Supabase 只看得到本服务器一个 IP，它自带的限流挡不住，也会被一个人耗尽、殃及所有用户。
        // 每个账号 10 分钟 10 次，每个 IP 每分钟 30 次（展会现场多人共用一个出口也够用）
        const perEmail = rateLimit(`login-email:${email}`, 10, 10 * 60_000);
        if (!perEmail.ok) return tooManyRequests(perEmail.retryAfterSec);
        const perIp = rateLimit(`login-ip:${clientIp(request)}`, 30, 60_000);
        if (!perIp.ok) return tooManyRequests(perIp.retryAfterSec);

        const supabase = await createClient();
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error || !data.user) {
            return NextResponse.json(
                { error: error?.message || 'Login failed' },
                { status: 401 },
            );
        }

        const user = await getSession();
        if (!user) {
            return NextResponse.json({ error: 'Authenticated profile is unavailable' }, { status: 502 });
        }

        return NextResponse.json({
            success: true,
            message: 'Login successful',
            user,
        });
    } catch (error) {
        console.error('Supabase login error:', error);
        return NextResponse.json({ error: 'Login failed' }, { status: 500 });
    }
}
