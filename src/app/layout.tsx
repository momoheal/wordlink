import type { Metadata, Viewport } from "next";
// Temporarily disabled due to Next.js 16 + Turbopack font loading issue
// import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./theme-palette.css";
import { cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';

// const geistSans = Geist({
//   variable: "--font-geist-sans",
//   subsets: ["latin"],
// });

// const geistMono = Geist_Mono({
//   variable: "--font-geist-mono",
//   subsets: ["latin"],
// });

export async function generateMetadata(): Promise<Metadata> {
  let locale = 'en';
  try {
    locale = await getLocale();
  } catch {}
  return {
    title: "Lexiverse",
    description: locale === 'zh'
      ? "Lexiverse - 面向英语学习者的 AI 语境阅读引擎。你读的下一篇文章，就是你的下一次复习。"
      : "Lexiverse - AI contextual reading engine for English learners. Your next article is your next review.",
    icons: {
      icon: '/icon.png',
      apple: '/icon.png',
    },
    manifest: '/manifest.json',
    appleWebApp: {
      capable: true,
      statusBarStyle: 'black-translucent',
      title: 'Lexiverse',
    },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  themeColor: '#000000',
  viewportFit: 'cover', // iOS全屏适配，覆盖刘海屏等
};

import { ThemeProvider } from "@/context/ThemeContext";
import { THEME_COOKIE } from "@/lib/theme";
import { SettingsProvider } from "@/context/SettingsContext";
import { ModuleConfigProvider } from "@/context/ModuleConfigContext";
import { AIProvider } from "@/components/ai/AIProvider";
import { AIComponents } from "@/components/ClientProviders";
import BackToHome from "@/components/BackToHome";
import AppChrome from "@/components/AppChrome";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();
  const theme = (await cookies()).get(THEME_COOKIE)?.value === 'light' ? 'light' : 'dark';

  return (
    <html lang={locale} data-theme={theme}>
      <head>
        {/* 字体已自托管到 /fonts 并内联进 globals.css（原 fonts.googleapis.com +
            db.onlinewebfonts.com 三条渲染阻塞外链已移除） */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              window.addEventListener('error', function(e) {
                if (e.message && (e.message.indexOf('Failed to load chunk') !== -1 || e.message.indexOf('ChunkLoadError') !== -1)) {
                  if (!sessionStorage.getItem('chunk_retry')) {
                    sessionStorage.setItem('chunk_retry', '1');
                    window.location.reload();
                  }
                }
              });
            `,
          }}
        />
      </head>
      <body
        className="antialiased"
        suppressHydrationWarning
      >
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider initialTheme={theme}>
            <SettingsProvider>
              <ModuleConfigProvider>
                <AIProvider>
                  <AppChrome>{children}</AppChrome>
                  <AIComponents />
                  <BackToHome />
                </AIProvider>
              </ModuleConfigProvider>
            </SettingsProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
