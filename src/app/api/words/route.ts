import { NextRequest, NextResponse } from 'next/server';
import { getWordList } from '@/lib/data';

const CACHE_HEADERS = {
    'Cache-Control': 'public, max-age=1800, s-maxage=86400, stale-while-revalidate=604800',
};

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('query') || '';
    const includeDefinitions = searchParams.get('includeDefinitions') === 'true';
    // 词表只渲染简明释义：slim 时不带整段 definitions / comparison（和 library-words 一致）
    const slim = searchParams.get('slim') === 'true' || searchParams.get('slim') === '1';

    const words = await getWordList(query);

    if (includeDefinitions) {
        const { getQuizDataForWords } = await import('@/lib/data');
        const detailedWords = await getQuizDataForWords(words, slim);
        return NextResponse.json(detailedWords, { headers: CACHE_HEADERS });
    }

    return NextResponse.json(words, { headers: CACHE_HEADERS });
}
