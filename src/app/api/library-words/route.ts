import { NextRequest, NextResponse } from 'next/server';
import { getLibraryWords, getQuizDataForWords } from '@/lib/data';
import { denyLibraryRead } from '@/lib/library-access';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const pathParam = searchParams.get('path');

    if (!pathParam) {
        return new NextResponse('Path parameter is required', { status: 400 });
    }

    // 用户私有词库：仅属主或公开词库可读
    const denied = await denyLibraryRead(pathParam);
    if (denied) return denied;

    const groupIndexParam = searchParams.get('groupIndex');
    const groupSizeParam = searchParams.get('groupSize');
    const includeDefinitions = searchParams.get('includeDefinitions') === 'true';
    const slim = searchParams.get('slim') === 'true' || searchParams.get('slim') === '1';

    let words = await getLibraryWords(pathParam);

    if (groupIndexParam !== null) {
        const groupIndex = parseInt(groupIndexParam);
        // If index is -1, return all words (no slicing)
        if (groupIndex !== -1) {
            const groupSize = groupSizeParam ? parseInt(groupSizeParam) : 100;
            const start = groupIndex * groupSize;
            words = words.slice(start, start + groupSize);
        }
    }

    if (includeDefinitions) {
        const wordsWithData = await getQuizDataForWords(words, slim);
        return NextResponse.json(wordsWithData);
    }

    return NextResponse.json(words);
}
