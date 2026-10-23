import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth';

/**
 * Read access to a word library addressed by path. System libraries (files under data/word_library)
 * are public; a user library ("user:<id>") is readable by its owner, or by anyone once it is public.
 * Returns null when the caller may read it, otherwise the 404/403 response to send.
 */
export async function denyLibraryRead(path: string): Promise<NextResponse | null> {
    if (!path.startsWith('user:')) return null;

    const library = await prisma.userLibrary.findUnique({
        where: { id: path.slice('user:'.length) },
        select: { userId: true, isPublic: true },
    });
    if (!library) {
        return NextResponse.json({ error: 'Library not found' }, { status: 404 });
    }
    if (library.isPublic) return null;

    const session = await getSession();
    if (!session || session.id !== library.userId) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return null;
}
