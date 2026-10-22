'use client';

import { useTranslations } from 'next-intl';

// Keys in word_chinese "forms" that carry no actual form.
const EMPTY_FORM_KEYS = new Set(['none', 'no_variants']);

function humanize(key: string): string {
    const text = key.replace(/_/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Inflected forms ("past tense: abandoned") with readable, localized labels. */
export default function WordFormChips({ forms, compact = false }: { forms: Record<string, string>; compact?: boolean }) {
    const t = useTranslations('wordForms');
    const entries = Object.entries(forms).filter(([key, value]) => value && !EMPTY_FORM_KEYS.has(key));
    if (entries.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-2">
            {entries.map(([key, value]) => (
                <div key={key} className={`flex items-baseline gap-2 rounded-md border border-neutral-800 bg-neutral-900/50 ${compact ? 'px-2.5 py-1.5' : 'px-3 py-2'}`}>
                    <span className="text-xs text-neutral-500">{t.has(key) ? t(key) : humanize(key)}</span>
                    <span className="text-sm font-medium text-neutral-200">{value}</span>
                </div>
            ))}
        </div>
    );
}
