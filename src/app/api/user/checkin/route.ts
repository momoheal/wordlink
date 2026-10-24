import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession, ensureLocalUser } from '@/lib/auth';
import { SERVER_TZ, localDateStr, streakFromDays, streakWindowStart } from '@/lib/streak';

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    await ensureLocalUser(session);

    const now = new Date();
    const since = streakWindowStart(now);
    // timestamp 列为 TIMESTAMP(3)（存 UTC 墙钟），本地日期分桶需先按 UTC
    // 还原 instant 再转服务器本地时区。
    const tz = SERVER_TZ;

    // Day-level aggregation pushed into Postgres: ≤STREAK_WINDOW_DAYS rows per
    // table instead of every quiz/visit record.
    const [quizDays, visitDays] = await Promise.all([
      prisma.$queryRaw<{ day: string; total: number; correct: number }[]>`
        SELECT
          to_char("timestamp" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE "score" > 0)::int AS correct
        FROM "LPT_english"."QuizRecord"
        WHERE "userId" = ${session.id} AND "timestamp" >= ${since}
        GROUP BY 1
      `,
      prisma.$queryRaw<{ day: string; total: number }[]>`
        SELECT
          to_char("timestamp" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
          COUNT(*)::int AS total
        FROM "LPT_english"."WordVisit"
        WHERE "userId" = ${session.id} AND "timestamp" >= ${since}
        GROUP BY 1
      `,
    ]);

    const todayStr = localDateStr(now);

    // Today's quiz stats
    const todayQuizRow = quizDays.find(r => r.day === todayStr);
    const todayQuizCount = todayQuizRow?.total ?? 0;
    const todayCorrect = todayQuizRow?.correct ?? 0;

    // Today's total word activity count (visits + quiz, including repeats)
    const todayVisitCount = visitDays.find(r => r.day === todayStr)?.total ?? 0;
    const todayWordsCount = todayVisitCount + todayQuizCount;

    // Streak: consecutive days with any activity (quiz or visit), same rule as home and passport
    const streak = streakFromDays(new Set([
      ...quizDays.map(r => r.day),
      ...visitDays.map(r => r.day),
    ]), now);

    // Monthly: current month, each day's total activity count (quiz + visit, including repeats)
    const monthStartStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const monthlyMap: Record<string, number> = {};
    for (const r of quizDays) {
      if (r.day >= monthStartStr) monthlyMap[r.day] = (monthlyMap[r.day] || 0) + r.total;
    }
    for (const r of visitDays) {
      if (r.day >= monthStartStr) monthlyMap[r.day] = (monthlyMap[r.day] || 0) + r.total;
    }
    const monthly = Object.entries(monthlyMap)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, count]) => ({ date, count }));

    // Weekly: last 7 days (including today), each day's total activity count
    const weeklyMap: Record<string, number> = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      weeklyMap[localDateStr(d)] = 0;
    }
    for (const r of quizDays) {
      if (r.day in weeklyMap) weeklyMap[r.day] += r.total;
    }
    for (const r of visitDays) {
      if (r.day in weeklyMap) weeklyMap[r.day] += r.total;
    }
    const weekly = Object.entries(weeklyMap).map(([date, count]) => ({ date, count }));

    return NextResponse.json({
      today: {
        date: todayStr,
        wordsStudied: todayWordsCount,
        quizCount: todayQuizCount,
        correctRate: todayQuizCount > 0 ? Math.round((todayCorrect / todayQuizCount) * 100) : 0,
      },
      streak,
      monthly,
      weekly,
    });
  } catch (error) {
    console.error('Checkin fetch error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
