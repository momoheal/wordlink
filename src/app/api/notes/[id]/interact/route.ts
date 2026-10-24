import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ensureLocalUser, getSession } from '@/lib/auth';
import { MAX_COMMENT_LENGTH, maskEmail } from '@/lib/notes';

// POST /api/notes/[id]/interact - Like, favorite, or comment on a note
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    try {
        const session = await getSession();
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        await ensureLocalUser(session);

        const noteExists = await prisma.word_notes.findUnique({
            where: { id },
            select: { id: true },
        });
        if (!noteExists) {
            return NextResponse.json({ error: 'Note not found' }, { status: 404 });
        }

        const body = await request.json().catch(() => ({}));
        const type = typeof body.type === 'string' ? body.type : '';
        const content = typeof body.content === 'string' ? body.content.trim() : '';

        if (!type || !['like', 'favorite', 'comment'].includes(type)) {
            return NextResponse.json({ error: 'Invalid interaction type' }, { status: 400 });
        }

        if (type === 'comment' && !content) {
            return NextResponse.json({ error: 'Comment content required' }, { status: 400 });
        }
        if (content.length > MAX_COMMENT_LENGTH) {
            return NextResponse.json({ error: 'Comment too long' }, { status: 400 });
        }

        // For like/favorite, use upsert to toggle
        if (type === 'like' || type === 'favorite') {
            // Check if interaction already exists
            const existing = await prisma.note_interactions.findUnique({
                where: {
                    userId_noteId_type: {
                        userId: session.id,
                        noteId: id,
                        type,
                    },
                },
            });

            if (existing) {
                // Unlike/unfavorite
                await prisma.note_interactions.delete({
                    where: {
                        id: existing.id,
                    },
                });
                return NextResponse.json({ action: 'removed', type });
            } else {
                // Like/favorite
                await prisma.note_interactions.create({
                    data: {
                        id: crypto.randomUUID(),
                        userId: session.id,
                        noteId: id,
                        type,
                    },
                });
                return NextResponse.json({ action: 'added', type });
            }
        }

        // 每人每条笔记只保留一条评论：已有就改写，没有就新建
        if (type === 'comment') {
            const existingComment = await prisma.note_interactions.findUnique({
                where: {
                    userId_noteId_type: {
                        userId: session.id,
                        noteId: id,
                        type: 'comment',
                    },
                },
                select: { id: true },
            });

            const select = {
                id: true,
                noteId: true,
                content: true,
                createdAt: true,
                User: { select: { email: true } },
            } as const;
            const comment = existingComment
                ? await prisma.note_interactions.update({
                    where: { id: existingComment.id },
                    data: { content },
                    select,
                })
                : await prisma.note_interactions.create({
                    data: {
                        id: crypto.randomUUID(),
                        userId: session.id,
                        noteId: id,
                        type: 'comment',
                        content,
                    },
                    select,
                });

            // 和 GET /api/notes 一样只返回脱敏的显示名，不带邮箱
            return NextResponse.json({
                id: comment.id,
                noteId: comment.noteId,
                content: comment.content,
                createdAt: comment.createdAt,
                username: maskEmail(comment.User.email),
            });
        }

        return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    } catch (error) {
        console.error('Error interacting with note:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
