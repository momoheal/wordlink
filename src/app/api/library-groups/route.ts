import { NextRequest, NextResponse } from 'next/server';
import { getLibraryGroups } from '@/lib/data';
import { denyLibraryRead } from '@/lib/library-access';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const pathParam = searchParams.get('path');
    const groupSizeParam = searchParams.get('groupSize');

    if (!pathParam) {
        return new NextResponse('Path parameter is required', { status: 400 });
    }

    // 用户私有词库：仅属主或公开词库可读（与 /api/library-words 同一规则）
    const denied = await denyLibraryRead(pathParam);
    if (denied) return denied;

    const groupSize = groupSizeParam ? parseInt(groupSizeParam) : 100;
    const groups = await getLibraryGroups(pathParam, groupSize);
    return NextResponse.json(groups);
}
