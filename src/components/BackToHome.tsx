'use client';

import { useEffect, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { shellRouteFor } from '@/components/AppChrome';
import { leaveAmbient, returnRoute, subscribeReturnRoute, trackRoute } from '@/lib/return-route';

const HIDDEN_PREFIXES = [
  '/',
  '/home',
  '/login',
  '/reset-password',
  '/auth',
  '/quiz',
  '/word',
  '/graph',
  '/immersive',
  '/model',
];

export default function BackToHome() {
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations('backToHome');
  // Mounted on every page, so this is where the app remembers where the ambient screen was opened from.
  useEffect(() => { trackRoute(pathname + window.location.search); }, [pathname]);
  const back = useSyncExternalStore(subscribeReturnRoute, returnRoute, () => null);
  if (HIDDEN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return null;
  if (pathname.startsWith('/read/')) return null;

  const isStudy = pathname === '/study' || pathname.startsWith('/study/');
  const isAmbient = pathname === '/ambient' || pathname.startsWith('/ambient/');
  // The ambient screen goes back where it was opened from, and says where that is.
  const target = isAmbient && back ? back : '/home';
  const under = (prefix: string) => target === prefix || target.startsWith(`${prefix}/`) || target.startsWith(`${prefix}?`);
  const label = target === '/home' ? t('label') : under('/study') ? t('study') : under('/read') ? t('reading') : t('back');
  const position = isAmbient
    ? 'right-4 top-4 md:right-8 md:top-6'
    : isStudy
      ? 'left-4 top-16'
      : 'left-4 top-4';
  // Pages with the icon rail already link home from its logo; keep the pill for phones only.
  const visibility = shellRouteFor(pathname)?.rail ? 'md:hidden' : '';

  return (
    <Link
      href={target}
      onClick={isAmbient ? (e) => { e.preventDefault(); leaveAmbient(router); } : undefined}
      aria-label={target === '/home' ? t('aria') : label}
      title={target === '/home' ? t('aria') : label}
      className={`fixed z-[120] inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/65 px-3.5 py-2 text-xs text-white/75 shadow-lg backdrop-blur-md transition hover:border-white/30 hover:bg-black/85 hover:text-white ${position} ${visibility}`}
    >
      <ArrowLeft size={14} />
      {label}
    </Link>
  );
}
