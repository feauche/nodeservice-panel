import { ASSISTANT_PERMISSIONS_DEFAULT, type AssistantPermissions } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { buildSystem } from './assistant.prompt.js';

const P = (over: Partial<AssistantPermissions> = {}): AssistantPermissions => ({
  ...ASSISTANT_PERMISSIONS_DEFAULT,
  ...over,
});

describe('системный промпт Джарвиса', () => {
  it('режима «Анализ» нет: вместо него правила, как понять присланный материал', () => {
    const s = buildSystem('intermediate', P());
    expect(s).not.toContain('РЕЖИМ «АНАЛИЗ»');
    expect(s).toContain('ЧТО ТЕБЕ ПРИСЛАЛИ');
    for (const part of [
      'Статья, мануал',
      'Словарь терминов',
      'Вывод команды',
      'Секреты',
      'Непонятно, что это',
    ])
      expect(s).toContain(part);
    expect(s).toContain('search_kb');
    expect(s).toContain('add_glossary_terms');
    expect(s).toContain('Говори «сохранил» или «добавил» только по ответу инструмента');
  });
  it('справочник и карта панели на месте', () => {
    const s = buildSystem('intermediate', P());
    expect(s).toContain('get_reference');
    expect(s).toContain('КАРТА ПАНЕЛИ');
    expect(s).toContain('ТЕКУЩЕЕ ВРЕМЯ СЕРВЕРА');
  });
  it('инструменты чтения по SSH называются только при включённых разрешениях', () => {
    const off = buildSystem('intermediate', P({ reach: false, processes: false, nodeLogs: false }));
    expect(off).not.toContain('check_reachability (');
    expect(off).not.toContain('inspect_processes (');
    expect(off).not.toContain('inspect_node_logs (');
    const on = buildSystem('intermediate', P({ nodeLogs: true }));
    expect(on).toContain('check_reachability (');
    expect(on).toContain('inspect_node_logs (');
  });
  it('подробность меняет только одну строку, разрешения перечислены', () => {
    expect(buildSystem('pro', P())).toContain('«КРАТКО»');
    expect(buildSystem('novice', P())).toContain('«ПОДРОБНО»');
    expect(buildSystem('intermediate', P())).toContain('«ОБЫЧНО»');
    expect(buildSystem('intermediate', P({ kbWrite: false }))).toContain(
      'Создание и правка статей — запрещено',
    );
  });
  it('новые инструменты памяти названы, есть правило про происхождение сказанного', () => {
    const s = buildSystem('intermediate', P());
    expect(s).toContain('search_conversations');
    expect(s).toContain('Помечай происхождение сказанного');
    expect(s).toContain('возможно, устарело');
  });
  it('инструменты осмотра и журналов названы только при своих разрешениях', () => {
    const none = buildSystem('intermediate', P({ inspect: false, serviceLogs: false, nodeLogs: false }));
    for (const n of ['inspect_containers (', 'inspect_ports (', 'inspect_logs (', 'check_certificate ('])
      expect(none, n).not.toContain(n);
    const inspectOnly = buildSystem('intermediate', P({ inspect: true, serviceLogs: false }));
    expect(inspectOnly).toContain('inspect_containers (');
    expect(inspectOnly).toContain('check_certificate (');
    expect(inspectOnly).not.toContain('inspect_logs (');
    expect(buildSystem('intermediate', P({ serviceLogs: true }))).toContain('inspect_logs (');
    expect(buildSystem('intermediate', P())).toContain('get_panel_status');
  });
  it('правила парка попадают в инструкцию только когда владелец их написал', () => {
    expect(buildSystem('intermediate', P())).not.toContain('ПРАВИЛА ПАРКА (их написал');
    expect(buildSystem('intermediate', P(), { fleetRules: null })).not.toContain('ПРАВИЛА ПАРКА (их написал');
    const s = buildSystem('intermediate', P(), { fleetRules: '## Нормы\nCPU до 60 %.' });
    expect(s).toContain('ПРАВИЛА ПАРКА (их написал владелец');
    expect(s).toContain('CPU до 60 %.');
    expect(s.indexOf('ПРАВИЛА ПАРКА (их написал')).toBeLessThan(s.indexOf('КАРТА ПАНЕЛИ'));
  });
  it('про профиль сервера: критичный, снимок перепроверяют, опрос владельца, статью не меняют', () => {
    const s = buildSystem('intermediate', P());
    expect(s).toContain('КРИТИЧНОГО сервера');
    expect(s).toContain('перепроверь свежим inspect_containers');
    expect(s).toContain('profileFilled=false');
    expect(s).toContain('задавай короткие вопросы по одному блоку');
    expect(s).toContain('Саму статью ты не меняешь');
  });
});
