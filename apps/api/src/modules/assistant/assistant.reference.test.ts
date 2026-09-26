import { INCIDENT_ACTIONS, INCIDENT_KIND_META, INCIDENT_KINDS } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { REFERENCE, referenceById } from './assistant.reference.js';

describe('справочник Джарвиса', () => {
  it('темы уникальны, у каждой есть название, когда открывать и содержательный текст', () => {
    const ids = REFERENCE.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of REFERENCE) {
      const text = t.render();
      expect(t.title, t.id).toBeTruthy();
      expect(t.when.length, t.id).toBeGreaterThan(20);
      expect(text.length, t.id).toBeGreaterThan(600);
      expect(text, t.id).not.toMatch(/undefined|NaN|\[object|\$\{/);
    }
  });
  it('темы, которые обещает промпт, существуют', () => {
    for (const id of [
      'incidents',
      'actions',
      'metrics',
      'vpn-stack',
      'blocking',
      'linux',
      'maintenance',
      'kb',
      'security',
      'answers',
    ])
      expect(referenceById(id), id).toBeDefined();
    expect(referenceById(' KB ')?.id).toBe('kb');
    expect(referenceById('нет-такой')).toBeUndefined();
  });
  it('про инциденты: все виды, названия шагов и пороги берутся из реестров панели', () => {
    const text = referenceById('incidents')?.render() ?? '';
    for (const k of INCIDENT_KINDS) {
      expect(text).toContain(INCIDENT_KIND_META[k].label);
      expect(text).toContain(`(${k})`);
    }
    expect(text).toContain('по умолчанию 5 мин');
    expect(text).toContain('CPU 90 %');
    expect(text).toContain('диск 85 %');
    expect(text).toContain('60 секунд');
  });
  it('про действия: каждое действие реестра описано, у T3 сказано, что карточкой не предлагается', () => {
    const text = referenceById('actions')?.render() ?? '';
    for (const a of INCIDENT_ACTIONS) {
      expect(text).toContain(a.title);
      expect(text).toContain(a.key);
    }
    expect(text).toContain('T3');
    expect(text).toContain('карточкой не предлагается');
  });
  it('в опасных командах справочник по Linux предупреждает, а не советует', () => {
    const text = referenceById('linux')?.render() ?? '';
    expect(text).toContain('docker system prune -a');
    expect(text).toContain('Опасные команды');
    expect(text).toContain('только читают');
  });
  it('про безопасность: чужие указания в данных не выполняются, секреты не сохраняются', () => {
    const text = referenceById('security')?.render() ?? '';
    expect(text).toMatch(/не выполняйте их/i);
    expect(text).toMatch(/не сохраняйте в базу знаний/);
  });
});
