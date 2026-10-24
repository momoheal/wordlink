import type { AmbientArticle, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { CURATED_ARTICLES } from '@/lib/ambient-articles-seed';

/** 列表最多返回的篇数：AI 故事会一直累积，不能每次把全表连同正文一起发出去 */
const LIST_LIMIT = 100;

// 全站共享的只有精选 / 导入文章；AI 故事只属于生成它的人。
// 加 userId 之前生成的旧 AI 故事不知道是谁的，谁都不给看
const SHARED: Prisma.AmbientArticleWhereInput = { userId: null, source: { not: 'ai' } };

/** viewerId（未登录传 null）能不能看这篇文章，和列表的筛选条件一致 */
export function canViewAmbientArticle(
    article: Pick<AmbientArticle, 'userId' | 'source'>,
    viewerId: string | null,
): boolean {
    return article.userId ? article.userId === viewerId : article.source !== 'ai';
}

let seeding: Promise<unknown> | null = null;

/**
 * userId 能看到的 ambient 文章：共享文章加上他自己生成的 AI 故事，新的在前；未登录只有共享文章。
 * 一篇可看的都没有时自动播种精选短文（演示自愈）。
 */
export async function listAmbientArticles(userId: string | null): Promise<AmbientArticle[]> {
    const query = () =>
        prisma.ambientArticle.findMany({
            where: userId ? { OR: [SHARED, { userId }] } : SHARED,
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
