import { describe, expect, it } from 'vitest';

import { normalizeTag, similarTag, tagCounts, tagDistance } from './tags.js';

describe('теги', () => {
  it('один вид: строчные, пробел — дефис, лишнее убрано', () => {
    expect(normalizeTag('  Node Main! ')).toBe('node-main');
    expect(normalizeTag('Аренда')).toBe('аренда');
  });

  it('перестановка соседних букв — одна ошибка', () => {
    expect(tagDistance('noed', 'node')).toBe(1);
    expect(tagDistance('rnt', 'rent')).toBe(1);
    expect(tagDistance('de', 'nl')).toBe(2);
  });

  it('опечатка ловится только у редкого тега и только против популярного', () => {
    const counts = { node: 5, exit: 4, rent: 3, de: 2, nl: 2, noed: 1 };
    expect(similarTag('noed', counts)).toEqual({ tag: 'node', count: 5 });
    expect(similarTag('rnt', counts)).toEqual({ tag: 'rent', count: 3 });
    expect(similarTag('germany', counts)).toBeNull();
    expect(similarTag('node', counts)).toBeNull();
    expect(similarTag('no', counts)).toBeNull();
    expect(tagCounts([{ tags: ['a', 'b'] }, { tags: ['a'] }])).toEqual({ a: 2, b: 1 });
  });
});
