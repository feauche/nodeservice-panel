import { KB_SOURCES, type KbSource } from '@nodeservice/shared';

/** Значения полей редактора статьи (теги — строкой через запятую, как в поле ввода). */
export interface KbFormValues {
  title: string;
  tags: string;
  content: string;
  source: KbSource;
}

export interface KbDraft extends KbFormValues {
  savedAt: string;
}

const keyOf = (docId?: string): string => `ns-kb-draft:${docId ?? 'new'}`;

export const sameValues = (a: KbFormValues, b: KbFormValues): boolean =>
  a.title === b.title && a.tags === b.tags && a.content === b.content && a.source === b.source;

/** Черновик статьи из localStorage; хранилище может быть недоступно или повреждено — тогда просто null. */
export function readDraft(docId?: string): KbDraft | null {
  try {
    const raw = localStorage.getItem(keyOf(docId));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<KbDraft> | null;
    if (
      !p ||
      typeof p.title !== 'string' ||
      typeof p.tags !== 'string' ||
      typeof p.content !== 'string' ||
      typeof p.savedAt !== 'string' ||
      !KB_SOURCES.includes(p.source as KbSource)
    )
      return null;
    return {
      title: p.title,
      tags: p.tags,
      content: p.content,
      source: p.source as KbSource,
      savedAt: p.savedAt,
    };
  } catch {
    return null;
  }
}

/** Сохраняет черновик; возвращает время сохранения (ISO) или null, если записать не удалось. */
export function writeDraft(docId: string | undefined, values: KbFormValues): string | null {
  try {
    const savedAt = new Date().toISOString();
    localStorage.setItem(keyOf(docId), JSON.stringify({ ...values, savedAt } satisfies KbDraft));
    return savedAt;
  } catch {
    return null;
  }
}

export function clearDraft(docId?: string): void {
  try {
    localStorage.removeItem(keyOf(docId));
  } catch {
    /* хранилище недоступно — черновика там и нет */
  }
}
