import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// PATCH: Update word
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; wordId: string }> }
) {
  try {
    const { id, wordId } = await params;
    const session = await getSession();
    if (!session?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Verify library ownership
    const library = await prisma.userLibrary.findUnique({
      where: { id: id },
    });

    if (!library || library.userId !== session.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { word } = body;

    if (!word || typeof word !== 'string') {
      return NextResponse.json({ error: 'Word is required' }, { status: 400 });
    }

    const normalizedWord = word.trim().toLowerCase();

    // Validate word format
    if (!/^[a-z'-]+$/i.test(normalizedWord)) {
      return NextResponse.json(
        { error: 'Invalid word format' },
        { status: 400 }
      );
    }

    // Check if word already exists (excluding current word)
    const existing = await prisma.userLibraryWord.findFirst({
      where: {
        libraryId: id,
        word: normalizedWord,
        id: { not: wordId },
      },
    });

    if (existing) {
      return NextResponse.json(
        { error: 'Word already exists in library' },
        { status: 400 }
      );
    }

    // Scope the write to this library: owning library `id` says nothing about a word id taken from
    // someone else's library.
    const { count } = await prisma.userLibraryWord.updateMany({
      where: { id: wordId, libraryId: id },
      data: { word: normalizedWord },
    });
    if (count === 0) {
      return NextResponse.json({ error: 'Word not found' }, { status: 404 });
    }

    const updated = await prisma.userLibraryWord.findUnique({ where: { id: wordId } });
    return NextResponse.json({ word: updated });
  } catch (error) {
    console.error('Error updating word:', error);
    return NextResponse.json(
      { error: 'Failed to update word' },
      { status: 500 }
    );
  }
}

// DELETE: Delete single word
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; wordId: string }> }
) {
  try {
    const { id, wordId } = await params;
    const session = await getSession();
    if (!session?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Verify library ownership
    const library = await prisma.userLibrary.findUnique({
      where: { id: id },
    });

    if (!library || library.userId !== session.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Only a word of this library may go, and the count drops only when one did.
    const deleted = await prisma.$transaction(async (tx) => {
      const { count } = await tx.userLibraryWord.deleteMany({
        where: { id: wordId, libraryId: id },
      });
      if (count > 0) {
        await tx.userLibrary.update({
          where: { id: id },
          data: { wordCount: { decrement: count } },
        });
      }
      return count;
    });
    if (deleted === 0) {
      return NextResponse.json({ error: 'Word not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting word:', error);
    return NextResponse.json(
      { error: 'Failed to delete word' },
      { status: 500 }
    );
  }
}
