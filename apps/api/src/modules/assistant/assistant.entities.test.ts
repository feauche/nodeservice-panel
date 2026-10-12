import {
  billingItemSchema,
  bsRentalSchema,
  nodeTcpDiagnosticsSchema,
  remnawaveNodeSchema,
} from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { documentedKeys, ENTITY_DOCS, renderEntities, typeLabel } from './assistant.entities.js';

const REMOVED = /SSH|агент|терминал|автопочин/i;
const NEGATION = /(?:^|[^а-яё])(?:нет|не|ни|без)(?:[^а-яё]|$)|истори|прежн|убран|удалён|больше не/i;

describe('сущности панели для Ассистента', () => {
  for (const e of ENTITY_DOCS) {
    it(`«${e.title}»: у каждого поля схемы есть описание или причина, почему оно скрыто; лишних описаний нет`, () => {
      expect(
        Object.keys(e.fields).sort(),
        `Поля ${e.id} разошлись со схемой API: обновите ENTITY_DOCS в assistant.entities.ts`,
      ).toEqual(documentedKeys(e).sort());
      for (const k of documentedKeys(e))
        expect(e.fields[k]?.trim().length, `${e.id}.${k}`).toBeGreaterThan(8);
      for (const [k, why] of Object.entries(e.hidden ?? {})) {
        expect(why.length, `${e.id}.${k}`).toBeGreaterThan(15);
        expect(e.fields, `${e.id}.${k} и описано, и скрыто`).not.toHaveProperty(k);
      }
      expect(e.where.length, e.id).toBeGreaterThan(20);
    });
  }

  it('набор сущностей — про ноды: своих серверов, агента и предложений больше нет', () => {
    const ids = ENTITY_DOCS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      [
        'billing-item',
        'bs-check',
        'custom-site',
        'dpi-check',
        'incident',
        'integration',
        'kb-article',
        'node',
        'node-settings',
        'provider',
        'scenario',
        'tcp-check',
      ].sort(),
    );
  });

  it('типы полей читаются по-человечески', () => {
    const node = remnawaveNodeSchema.shape;
    expect(typeLabel(node.name)).toBe('строка');
    expect(typeLabel(node.port as z.ZodType)).toBe('число или null');
    expect(typeLabel(node.isConnected)).toBe('да/нет');
    expect(typeLabel(node.lastStatusMessage)).toBe('строка или null');
    expect(typeLabel(node.loadAverage as z.ZodType)).toBe('список (число или null)');
    expect(typeLabel(billingItemSchema.shape.kind)).toBe('server | rent | domain | cert | other');
    expect(typeLabel(nodeTcpDiagnosticsSchema.shape.source)).toBe('checkhost');
    expect(typeLabel(bsRentalSchema.shape.id as z.ZodType)).toBe('строка или число');
  });

  it('текст: где меняется, служебные поля прежних версий скрыты, удалённое — только с отрицанием', () => {
    const text = renderEntities();
    expect(text).toContain('**uuid**');
    expect(text).toContain('окно ноды → «Настройки» → «Провайдер ноды»');
    expect(text).toContain('у Ассистента инструментов записи нет, кроме базы знаний');
    for (const hidden of [
      '**serverIds**',
      '**linkedBy**',
      '**serverId**',
      '**attempts**',
      '**proposal**',
      '**analysis**',
    ])
      expect(text, hidden).not.toContain(hidden);
    for (const old of ['Хостинг', 'Профиль сервера', 'Снимок состояния', 'agentStatus', 'hostKeyFingerprint'])
      expect(text, old).not.toContain(old);
    expect(text).not.toMatch(/undefined|\[object/);
    const bad = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => REMOVED.test(s) && !NEGATION.test(s));
    expect(bad).toEqual([]);
  });
});
