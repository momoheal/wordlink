import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ensureLocalUser, getSession } from '@/lib/auth';
import { MAX_NOTE_LENGTH, maskEmail } from '@/lib/notes';

// GET /api/notes?word={word} - Get all notes for a word
export async function GET(request: Request) {
    try {
        const session = await getSession();
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        await ensureLocalUser(session);

        const word = new URL(request.url).searchParams.get('word')?.trim();

        if (!word) {
            return NextResponse.json({ error: 'Word parameter required' }, { status: 400 });
        }

        // Get all notes for this word (author info only — interaction rows are
        // aggregated separately instead of pulling every row into JS)
        const notes = await prisma.word_notes.findMany({
            where: { word },
            take: 200,
            select: {
                id: true,
                userId: true,
                word: true,
                content: true,
                createdAt: true,
                updatedAt: true,
                User: {
                    select: {
                        id: true,
                        email: true,
                    },
                },
            },
            orderBy: {
                createdAt: 'desc',
            },
        });

        if (notes.length === 0) {
            return NextResponse.json([]);
        }

        const noteIds = notes.map(n => n.id);

        // 一条 groupBy 统计各 note 的 like/favorite/comment 数；
        // 评论正文与当前用户自己的 interaction 分开查，避免拉全量 interaction 行
        const [typeCounts, commentRows, myInteractions] = await Promise.all([
            prisma.note_interactions.groupBy({
                by: ['noteId', 'type'],
                where: { noteId: { in: noteIds } },
                _count: { _all: true },
            }),
            prisma.note_interactions.findMany({
                where: { noteId: { in: noteIds }, type: 'comment' },
                select: {
                    noteId: true,
                    content: true,
                    createdAt: true,
                    User: {
                        select: {
                            email: true,
                        },
                    },
                },
                orderBy: { createdAt: 'asc' },
            }),
            prisma.note_interactions.findMany({
                where: { noteId: { in: noteIds }, userId: session.id },
                select: { noteId: true, type: true },
            }),
        ]);

        const likeCounts = new Map<string, number>();
        const favoriteCounts = new Map<string, number>();
        for (const row of typeCounts) {
            // _count 是 { _all: n } 对象；之前按 number 判断，点赞和收藏数永远是 0
            const n = row._count._all;
            if (row.type === 'like') likeCounts.set(row.noteId, n);
            else if (row.type === 'favorite') favoriteCounts.set(row.noteId, n);
        }

        const commentsByNote = new Map<string, typeof commentRows>();
        for (const c of commentRows) {
            const list = commentsByNote.get(c.noteId);
            if (list) list.push(c);
            else commentsByNote.set(c.noteId, [c]);
        }

        const myTypesByNote = new Map<string, Set<string>>();
        for (const i of myInteractions) {
            const set = myTypesByNote.get(i.noteId);
            if (set) set.add(i.type);
            else myTypesByNote.set(i.noteId, new Set([i.type]));
        }

        // Calculate interaction stats for each note
        const notesWithStats = notes.map(note => {
            const comments = commentsByNote.get(note.id) || [];

            return {
                id: note.id,
                userId: note.userId,
                word: note.word,
                content: note.content,
                createdAt: note.createdAt,
                updatedAt: note.updatedAt,
                user: {
                    id: note.User.id,
                    username: maskEmail(note.User.email),
                },
                likeCount: likeCounts.get(note.id) || 0,
                favoriteCount: favoriteCounts.get(note.id) || 0,
                commentCount: comments.length,
                hasUserLiked: myTypesByNote.get(note.id)?.has('like') || false,
                hasUserFavorited: myTypesByNote.get(note.id)?.has('favorite') || false,
                comments: comments.map(c => ({
                    content: c.content,
                    username: maskEmail(c.User.email),
                    createdAt: c.createdAt,
                })),
            };
        });

        return NextResponse.json(notesWithStats);
    } catch (error) {
        console.error('Error fetching notes:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// POST /api/notes - Create a new note
export async function POST(request: Request) {
    try {
        const session = await getSession();
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        await ensureLocalUser(session);

        const body = await request.json().catch(() => ({}));
        const word = typeof body.word === 'string' ? body.word.trim() : '';
        const content = typeof body.content === 'string' ? body.content.trim() : '';

        if (!word || !content) {
            return NextResponse.json({ error: 'Word and content required' }, { status: 400 });
        }
        if (word.length > 200 || content.length > MAX_NOTE_LENGTH) {
            return NextResponse.json({ error: 'Content too long' }, { status: 400 });
        }

        const note = await prisma.word_notes.create({
            data: {
                id: crypto.randomUUID(),
                userId: session.id,
                word,
                content,
                updatedAt: new Date(),
            },
            include: {
                User: {
                    select: {
                        id: true,
                        email: true,
                    },
                },
            },
        });

        return NextResponse.json({
            id: note.id,
            userId: note.userId,
            word: note.word,
            content: note.content,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt,
            user: {
                id: note.User.id,
                username: maskEmail(note.User.email),
            },
        });
    } catch (error) {
        console.error('Error creating note:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
