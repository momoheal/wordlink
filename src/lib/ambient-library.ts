import type { AmbientArticle } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { CURATED_ARTICLES } from '@/lib/ambient-articles-seed';

/** 列表最多返回的篇数：AI 故事会一直累积，不能每次把全表连同正文一起发出去 */
const LIST_LIMIT = 100;

let seeding: Promise<unknown> | null = null;

/** ambient 文章库，新的在前。库空时自动播种精选短文（演示自愈）。 */
export async function listAmbientArticles(): Promise<AmbientArticle[]> {
    const query = () =>
        prisma.ambientArticle.findMany({
            orderBy: { createdAt: 'desc' },
            take: LIST_LIMIT,
        });

    const articles = await query();
    if (articles.length > 0) return articles;

    // 同一进程里并发的首批请求共用一次播种，不重复写入
    seeding ??= prisma.ambientArticle
        .createMany({
            data: CURATED_ARTICLES.map((a) => ({
                title: a.title,
                titleZh: a.titleZh,
                level: a.level,
                season: a.season,
                source: 'curated',
                paragraphs: JSON.parse(JSON.stringify(a.paragraphs)),
                wordCount: a.paragraphs.reduce((acc, p) => acc + p.en.trim().split(/\s+/).length, 0),
            })),
        })
        .finally(() => {
            seeding = null;
        });
    await seeding;
    return query();
}
