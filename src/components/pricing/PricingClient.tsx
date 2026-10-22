'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, Check, Crown, Loader2, Sparkles } from 'lucide-react';

interface MeResponse {
    user: {
        id: string;
        email: string;
        isPro?: boolean;
        plan?: string;
        planExpiresAt?: string | null;
    } | null;
    usage?: {
        aiChat?: { used: number; limit: number };
        ambientGenerate?: { used: number; limit: number };
    };
    payConfigured?: boolean;
}

const PRODUCT_KEYS = ['pro_monthly', 'pro_yearly'] as const;
const PRODUCT_AMOUNTS: Record<(typeof PRODUCT_KEYS)[number], string> = {
    pro_monthly: '19.90',
    pro_yearly: '168.00',
};

export default function PricingClient() {
    const t = useTranslations('pricing');
    const locale = useLocale();
    const router = useRouter();

    const [me, setMe] = useState<MeResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [buying, setBuying] = useState<string | null>(null);
    const [error, setError] = useState('');

    useEffect(() => {
        fetch('/api/auth/me', { credentials: 'include' })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => setMe(data))
            .catch(() => setMe(null))
            .finally(() => setLoading(false));
    }, []);

    const user = me?.user ?? null;
    const isProUser = Boolean(user?.isPro);
    const payConfigured = Boolean(me?.payConfigured);

    const expiryLabel = (() => {
        if (!isProUser) return '';
        if (!user?.planExpiresAt) return t('proLifetime');
        const date = new Date(user.planExpiresAt);
        return t('proUntil', {
            date: date.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
            }),
        });
    })();

    const handleBuy = async (product: string) => {
        if (buying || !payConfigured) return;
        setBuying(product);
        setError('');
        try {
            const res = await fetch('/api/pay/orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ product }),
            });
            if (res.status === 401) {
                router.push('/login');
                return;
            }
            const data = await res.json().catch(() => null);
            if (res.status === 503 || data?.code === 'PAY_NOT_CONFIGURED') {
                setError(t('notConfigured'));
                return;
            }
            if (!res.ok || !data?.payUrl) {
                setError(t('orderFailed'));
                return;
            }
            window.location.href = data.payUrl;
        } catch {
            setError(t('orderFailed'));
        } finally {
            setBuying(null);
        }
    };

    return (
        <div className="relative min-h-screen bg-black text-[#e5e7eb] font-sans antialiased overflow-x-hidden">
            {/* 背景氛围光斑，与 landing 同一风格 */}
            <div className="pointer-events-none fixed inset-0 z-0 opacity-50">
                <div className="absolute left-1/4 top-0 h-96 w-96 rounded-full bg-violet-600/15 blur-[120px]" />
                <div className="absolute right-1/4 top-1/3 h-96 w-96 rounded-full bg-cyan-600/15 blur-[140px]" />
            </div>

            <header className="sticky top-0 z-50 backdrop-blur-xl bg-black/60 border-b border-white/[0.08]">
                <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
                    <Link href="/home" className="flex items-center gap-2 text-xs text-white/60 hover:text-white transition-colors">
                        <ArrowLeft size={14} />
                        <span>{t('backHome')}</span>
                    </Link>
                    <span className="font-serif italic text-lg tracking-wider text-white" style={{ fontFamily: "'Instrument Serif', serif" }}>
                        Lexiverse
                    </span>
                    <div className="w-16" />
                </div>
            </header>

            <main className="relative z-10 max-w-5xl mx-auto px-6 pt-16 pb-24">
                <div className="text-center space-y-4">
                    <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-amber-300/25 bg-amber-400/10 text-xs font-medium text-amber-200">
                        <Crown size={13} />
                        <span>PRO</span>
                    </div>
                    <h1
                        className="text-5xl sm:text-6xl font-serif italic text-white tracking-tight"
                        style={{ fontFamily: "'Instrument Serif', serif" }}
                    >
                        {t('title')}
                    </h1>
                    <p className="max-w-xl mx-auto text-sm text-white/60 leading-relaxed">{t('subtitle')}</p>

                    {/* 当前 plan 状态 */}
                    {!loading && (
                        <div className="inline-flex items-center gap-2 text-xs">
                            {isProUser ? (
                                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/15 border border-emerald-400/30 text-emerald-300">
                                    <Check size={12} />
                                    {expiryLabel}
                                </span>
                            ) : (
                                <span className="px-3 py-1 rounded-full bg-white/5 border border-white/10 text-white/50">
                                    {t('freePlan')}
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {/* 产品卡 */}
                <div className="mt-14 grid gap-6 sm:grid-cols-2 max-w-3xl mx-auto">
                    {PRODUCT_KEYS.map((key) => {
                        const isYearly = key === 'pro_yearly';
                        return (
                            <div
                                key={key}
                                className={`relative rounded-3xl border p-7 backdrop-blur-md transition-all ${
                                    isYearly
                                        ? 'border-amber-300/30 bg-gradient-to-b from-amber-400/[0.08] to-white/[0.02] shadow-[0_0_50px_rgba(251,191,36,0.08)]'
                                        : 'border-white/12 bg-white/[0.03]'
                                }`}
                            >
                                {isYearly && (
                                    <span className="absolute -top-3 right-6 px-3 py-1 rounded-full bg-amber-400 text-black text-[10px] font-bold uppercase tracking-wider">
                                        {t('pro_yearly.badge')}
                                    </span>
                                )}
                                <h2 className="text-sm font-semibold text-white/85">{t(`${key}.name`)}</h2>
                                <p className="mt-1 text-xs text-white/45">{t(`${key}.desc`)}</p>
                                <div className="mt-5 flex items-baseline gap-1">
                                    <span className="text-lg text-white/70">¥</span>
                                    <span className="text-4xl font-semibold text-white tracking-tight">
                                        {PRODUCT_AMOUNTS[key]}
                                    </span>
                                    <span className="text-xs text-white/40">
                                        {isYearly ? t('perYear') : t('perMonth')}
                                    </span>
                                </div>

                                <button
                                    type="button"
                                    onClick={() => handleBuy(key)}
                                    disabled={loading || !payConfigured || buying !== null}
                                    className={`mt-6 flex w-full items-center justify-center gap-2 rounded-full py-3 text-xs font-semibold transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${
                                        isYearly
                                            ? 'bg-amber-300 text-black hover:bg-amber-200'
                                            : 'bg-white text-black hover:bg-white/90'
                                    }`}
                                >
                                    {buying === key ? (
                                        <Loader2 size={14} className="animate-spin" />
                                    ) : (
                                        <Sparkles size={14} />
                                    )}
                                    <span>
                                        {buying === key
                                            ? t('redirecting')
                                            : !user
                                              ? t('loginToBuy')
                                              : isProUser
                                                ? t('extend')
                                                : t('buy')}
                                    </span>
                                </button>
                            </div>
                        );
                    })}
                </div>

                {(error || (!loading && !payConfigured)) && (
                    <p className="mt-6 text-center text-xs text-amber-200/80">
                        {error || t('notConfigured')}
                    </p>
                )}

                {/* 权益 */}
                <div className="mt-16 max-w-3xl mx-auto rounded-3xl border border-white/10 bg-white/[0.02] p-8 backdrop-blur-md">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">
                        {t('benefitsTitle')}
                    </h3>
                    <ul className="mt-5 grid gap-3 sm:grid-cols-2">
                        {(['benefit1', 'benefit2', 'benefit3', 'benefit4'] as const).map((k) => (
                            <li key={k} className="flex items-start gap-2.5 text-sm text-white/75">
                                <Check size={15} className="mt-0.5 shrink-0 text-emerald-300" />
                                <span>{t(k)}</span>
                            </li>
                        ))}
                    </ul>
                    {me?.usage?.aiChat && !isProUser && (
                        <p className="mt-6 border-t border-white/10 pt-4 text-xs text-white/40">
                            {t('freeLimits', {
                                chat: me.usage.aiChat.limit,
                                stories: me.usage.ambientGenerate?.limit ?? 3,
                            })}
                        </p>
                    )}
                </div>
            </main>
        </div>
    );
}
