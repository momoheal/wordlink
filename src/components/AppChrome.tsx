'use client';

import { usePathname } from 'next/navigation';
import AppRail from '@/components/home/AppRail';
import BottomTabBar from '@/components/mobile/BottomTabBar';

interface ShellRoute {
  prefix: string;
  /** Only the route itself, not its sub-pages (e.g. /quiz but not a running /quiz/spelling session). */
  exact?: boolean;
  /** Icon rail on the left (md and up). */
  rail: boolean;
  /** Bottom tab bar on phones. */
  mobileBar: boolean;
}

const SHELL_ROUTES: ShellRoute[] = [
  { prefix: '/home', rail: false, mobileBar: true },
  { prefix: '/study', rail: true, mobileBar: false },
  { prefix: '/read', exact: true, rail: true, mobileBar: false },
  { prefix: '/quiz', exact: true, rail: true, mobileBar: false },
  { prefix: '/my-libraries', rail: true, mobileBar: true },
  { prefix: '/passport', rail: true, mobileBar: true },
  { prefix: '/dashboard', rail: true, mobileBar: false },
  { prefix: '/history', rail: true, mobileBar: false },
  { prefix: '/settings', rail: true, mobileBar: false },
];

export function shellRouteFor(pathname: string): ShellRoute | undefined {
  return SHELL_ROUTES.find(({ prefix, exact }) => pathname === prefix || (!exact && pathname.startsWith(`${prefix}/`)));
}

/** Shared application chrome for tool-like pages: icon rail on desktop, tab bar on phones. */
export default function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const route = shellRouteFor(pathname);
  if (!route) return <>{children}</>;

  return (
    <>
      <div className={route.rail ? 'md:pl-[60px]' : ''}>{children}</div>
      {route.rail && <div className="hidden md:block"><AppRail /></div>}
      {route.mobileBar && <div className="md:hidden"><BottomTabBar forceShow /></div>}
    </>
  );
}
