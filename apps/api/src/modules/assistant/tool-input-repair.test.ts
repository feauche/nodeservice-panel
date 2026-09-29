import { describe, expect, it } from 'vitest';

import { repairToolInput } from './tool-input-repair.js';

describe('repairToolInput', () => {
  it('параметры, вписанные разметкой в текст, возвращаются в свои поля', () => {
    const r = repairToolInput({
      title: 'Агент не на связи',
      explanation:
        'Проверьте службу агента и её логи.</explanation> <parameter name="commands">[{"command":"systemctl status nodeservice-agent","note":"Запущена ли служба"},{"command":"journalctl -u nodeservice-agent -n 50 --no-pager","note":"Ошибки в логе"}]</parameter>',
    }) as Record<string, unknown>;
    expect(r.explanation).toBe('Проверьте службу агента и её логи.');
    expect(r.commands).toEqual([
      { command: 'systemctl status nodeservice-agent', note: 'Запущена ли служба' },
      { command: 'journalctl -u nodeservice-agent -n 50 --no-pager', note: 'Ошибки в логе' },
    ]);
  });
  it('заполненное моделью поле не перетирается; обычный текст с < и > не трогается', () => {
    const r = repairToolInput({
      explanation: 'Текст.</explanation><parameter name="commands">[]',
      commands: [{ command: 'df -h', note: 'диск' }],
      note: 'порт < 1024 и > 0',
    }) as Record<string, unknown>;
    expect(r.commands).toEqual([{ command: 'df -h', note: 'диск' }]);
    expect(r.explanation).toBe('Текст.');
    expect(r.note).toBe('порт < 1024 и > 0');
  });
  it('не объект — как есть', () => {
    expect(repairToolInput(null)).toBeNull();
    expect(repairToolInput([1])).toEqual([1]);
  });
});
