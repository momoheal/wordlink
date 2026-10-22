import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';

export interface QuizWord {
    word: string;
    chineseData: {
        concise_definition: string;
        pronunciation: string;
        definitions: { explanation_cn: string }[];
    } | null;
}

interface UseQuizDataParams {
    source: 'random' | 'library' | 'unfamiliar' | 'custom' | null;
    libraryPath?: string | null;
    groupIndex?: number | null;
    groupSize?: number;
    count?: number;
}

export function useQuizData({ source, libraryPath, groupIndex, groupSize = 10, count = 10 }: UseQuizDataParams) {
    const t = useTranslations('quizPages.common');
    const [words, setWords] = useState<QuizWord[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchWords = useCallback(async () => {
        if (!source) return;

        setLoading(true);
        setError(null);
        setWords([]);

        try {
            let quizWords: QuizWord[] = [];

            if (source === 'random') {
                const res = await fetch(`/api/quiz/words?count=${count}`);
                quizWords = await res.json();
            } else if (source === 'unfamiliar') {
                const res = await fetch(`/api/quiz/unfamiliar?count=${count * 2}`); // Fetch more for unfamiliar
                quizWords = await res.json();
                if (quizWords.length === 0) {
                    setError(t('noUnfamiliar'));
                }
            } else if (source === 'custom') {
                const customWordsJson = sessionStorage.getItem('customQuizWords');
                if (!customWordsJson) {
                    setError(t('noCustomWords'));
                    setLoading(false);
                    return;
                }
                const customWords = JSON.parse(customWordsJson);
                const dataRes = await fetch('/api/quiz/data', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ words: customWords })
                });
                quizWords = await dataRes.json();
            } else if (source === 'library' && libraryPath && groupIndex !== undefined && groupIndex !== null) {
                // Fetch words from library group
                const wordsRes = await fetch(`/api/library-words?path=${encodeURIComponent(libraryPath)}&groupIndex=${groupIndex}&groupSize=${groupSize}`);
                if (!wordsRes.ok) throw new Error('Failed to fetch library words');
                const wordList = await wordsRes.json();

                // Fetch data for these words
                const dataRes = await fetch('/api/quiz/data', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ words: wordList })
                });
                quizWords = await dataRes.json();
            }

            setWords(quizWords);
        } catch (err) {
            console.error('Failed to fetch quiz data:', err);
            setError(t('loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [source, libraryPath, groupIndex, groupSize, count, t]);

    useEffect(() => {
        fetchWords();
    }, [fetchWords]);

    return { words, loading, error, refetch: fetchWords };
}
