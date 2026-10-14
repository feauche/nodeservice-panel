import { describe, expect, it } from 'vitest';

import { changeFieldLabel, formatValue, metadataRows } from './audit-format';

describe('детали записи Журнала — словами, а не кодом', () => {
  it('значения: да/нет, списки, даты, вложенные поля', () => {
    expect(formatValue(true)).toBe('Да');
    expect(formatValue(false)).toBe('Нет');
    expect(formatValue(['exit', 'bridge'])).toBe('exit, bridge');
    expect(formatValue([])).toBe('—');
    expect(formatValue({ incidents: 30 })).toBe('Событий: 30');
    expect(formatValue('2026-10-14T09:30:00.000Z')).toMatch(/октября 2026/);
    expect(formatValue('обычный текст')).toBe('обычный текст');
  });

  it('частые записи: блокировка, отказ в запросе, инцидент', () => {
    const lock = metadataRows({ reason: 'idle', lockAfterMinutes: 15 });
    expect(lock).toEqual([
      { key: 'reason', label: 'Причина', value: 'Бездействие' },
      { key: 'lockAfterMinutes', label: 'Блокировка после, мин', value: '15' },
    ]);
    const denied = metadataRows({ reason: 'unauthenticated', method: 'POST', path: '/api/nodes' });
    expect(denied.map((r) => `${r.label}: ${r.value}`)).toEqual([
      'Причина: Нет входа',
      'Что пытались сделать: Действие (POST)',
      'Адрес запроса: /api/nodes',
    ]);
    const incident = metadataRows({ kind: 'server_down', status: 'resolved', by: 'auto' });
    expect(incident.map((r) => r.value)).toEqual(['Нода недоступна', 'Закрыт', 'Автоматически']);
  });

  it('поля изменений: известные — по-русски, неизвестные — как есть', () => {
    expect(changeFieldLabel('timeZone')).toEqual({ label: 'Часовой пояс', known: true });
    expect(changeFieldLabel('someNewField')).toEqual({ label: 'someNewField', known: false });
  });
});
