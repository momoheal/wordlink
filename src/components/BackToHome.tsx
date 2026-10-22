'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { shellRouteFor } from '@/components/AppChrome';

const HIDDEN_PREFIXES = [
  '/',
  '/home',
  '/login',
  '/reset-password',
  '/auth',
  '/admin',
  '/quiz',
  '/word',
  '/graph',
  '/immersive',
  '/model',
];

export default function BackToHome() {
  const pathname = usePathname();
  const t = useTranslations('backToHome');
  if (HIDDEN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return null;
  if (pathname.startsWith('/read/')) return null;

  const isStudy = pathname === '/study' || pathname.startsWith('/study/');
  const isAmbient = pathname === '/ambient' || pathname.startsWith('/ambient/');
  const position = isAmbient
    ? 'right-4 top-4 md:right-8 md:top-6'
    : isStudy
      ? 'left-4 top-16'
      : 'left-4 top-4';
  // Pages with the icon rail already link home from its logo; keep the pill for phones only.
  const visibility = shellRouteFor(pathname)?.rail ? 'md:hidden' : '';

  return (
    <Link
      href="/home"
      aria-label={t('aria')}
      title={t('aria')}
      className={`fixed z-[120] inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/65 px-3.5 py-2 text-xs text-white/75 shadow-lg backdrop-blur-md transition hover:border-white/30 hover:bg-black/85 hover:text-white ${position} ${visibility}`}
    >
      <ArrowLeft size={14} />
      {t('label')}
    </Link>
  );
}
