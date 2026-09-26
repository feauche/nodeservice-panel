import { serverSchema } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { ENTITY_DOCS, renderEntities, typeLabel } from './assistant.entities.js';

describe('сущности панели для Джарвиса', () => {
  for (const e of ENTITY_DOCS) {
    it(`«${e.title}»: у каждого поля схемы есть описание, лишних описаний нет`, () => {
      const keys = Object.keys(e.schema.shape).sort();
      expect(
        Object.keys(e.fields).sort(),
        `Поля ${e.id} разошлись со схемой API: обновите ENTITY_DOCS в assistant.entities.ts`,
      ).toEqual(keys);
      for (const k of keys) expect(e.fields[k]?.trim().length, `${e.id}.${k}`).toBeGreaterThan(8);
    });
  }
  it('идентификаторы сущностей уникальны', () => {
    const ids = ENTITY_DOCS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('типы полей читаются по-человечески', () => {
    const shape = serverSchema.shape;
    expect(typeLabel(shape.name)).toBe('строка');
    expect(typeLabel(shape.port)).toBe('число');
    expect(typeLabel(shape.notes)).toBe('строка или null');
    expect(typeLabel(shape.tags)).toBe('список (строка)');
    expect(typeLabel(shape.sshOk)).toBe('да/нет или null');
    expect(typeLabel(shape.authMethod)).toBe('panel-key | key');
  });
  it('в тексте есть поле провайдера у сервера, кто его правит, и пути интерфейса', () => {
    const text = renderEntities();
    expect(text).toContain('**providerId**');
    expect(text).toContain('Блок «Хостинг», поле «Провайдер»');
    expect(text).toContain('not_installed, installing, pending, online, offline');
    expect(text).toContain('Пишет панель');
    expect(text).not.toMatch(/undefined|\[object/);
  });
});
