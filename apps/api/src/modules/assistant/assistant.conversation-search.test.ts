import { describe, expect, it } from 'vitest';

import {
  type PastMessage,
  searchPastMessages,
  searchWords,
  snippetAround,
} from './assistant.conversation-search.js';

const msg = (content: string, over: Partial<PastMessage> = {}): PastMessage => ({
  conversationId: 'c1',
  title: 'Беседа',
  role: 'user',
  content,
  createdAt: new Date('2026-09-26T10:00:00.000Z'),
  ...over,
});

describe('searchWords', () => {
  it('слова без регистра и «ё», без коротких и повторов, не больше пяти', () => {
    expect(searchWords('Ёлка ёлка  DPI, а conntrack-лимит')).toEqual(['елка', 'dpi', 'conntrack-лимит']);
    expect(searchWords('a b')).toEqual([]);
    expect(searchWords('одно два три четыре пять шесть семь')).toHaveLength(5);
  });
});

describe('snippetAround', () => {
  it('берёт кусок вокруг слова, схлопывает переносы и ставит многоточия', () => {
    const text = `${'начало '.repeat(60)}\n\nСЕРВЕР ru упал ночью\n\n${'конец '.repeat(60)}`;
    const s = snippetAround(text, ['ru']);
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('СЕРВЕР ru упал ночью');
    expect(s).not.toContain('\n');
    expect(s.length).toBeLessThan(320);
  });
  it('слова нет — начало текста', () => {
    expect(snippetAround('просто текст', ['нет'])).toBe('просто текст');
  });
});

describe('searchPastMessages', () => {
  const rows = [
    msg('Почему упал сервер ru ночью?', { title: 'Про ru' }),
    msg('Он упал из-за нехватки памяти, OOM.', { role: 'assistant', title: 'Про ru' }),
    msg('Как поднять лимит conntrack?', { title: 'Про conntrack' }),
  ];
  it('находит сообщения, где есть ВСЕ слова, без учёта регистра и «ё»', () => {
    expect(searchPastMessages(rows, 'УПАЛ ночью', 8).map((h) => h.chat)).toEqual(['Про ru']);
    expect(searchPastMessages(rows, 'упал oom', 8)).toHaveLength(1);
    expect(searchPastMessages(rows, 'упал', 8)).toHaveLength(2);
  });
  it('роли называются по-человечески, лимит и пустой запрос работают', () => {
    const hits = searchPastMessages(rows, 'упал', 8);
    expect(hits.map((h) => h.who)).toEqual(['администратор', 'Джарвис']);
    expect(searchPastMessages(rows, 'упал', 1)).toHaveLength(1);
    expect(searchPastMessages(rows, 'а', 8)).toEqual([]);
  });
});
