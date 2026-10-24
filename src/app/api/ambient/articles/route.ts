import { NextResponse } from 'next/server';
import { CURATED_ARTICLES } from '@/lib/ambient-articles-seed';
import { listAmbientArticles } from '@/lib/ambient-library';

export const dynamic = 'force-dynamic';

/** 统计英文词数 */
function countWords(paragraphs: Array<{ en: string }>): number {
    return paragraphs.reduce((acc, p) => acc + p.en.trim().split(/\s+/).length, 0);
}

/**
 * GET /api/ambient/articles —— 沉浸式阅读文章列表。
 * 首次访问时自动播种 4 篇精选短文（零外部依赖，演示自愈）。
 */
export async function GET() {
    try {
        const articles = await listAmbientArticles();

        return NextResponse.json(
            articles.map((a) => ({
                id: a.id,
                title: a.title,
                titleZh: a.titleZh,
                level: a.level,
                season: a.season,
                source: a.source,
                paragraphs: a.paragraphs,
                wordCount: a.wordCount,
                createdAt: a.createdAt,
            })),
            { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
        );
    } catch (error) {
        console.error('Failed to list ambient articles:', error);
        // 数据库不可用时兜底返回内存精选内容，保证屏保功能永不中断
        return NextResponse.json(
            CURATED_ARTICLES.map((a, i) => ({
                id: `fallback-${i}`,
                title: a.title,
                titleZh: a.titleZh,
                level: a.level,
                season: a.season,
                source: 'curated',
                paragraphs: a.paragraphs,
                wordCount: countWords(a.paragraphs),
            })),
            { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
        );
    }
}
