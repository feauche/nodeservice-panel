import { CHANGELOG, INCIDENT_ACTIONS, INCIDENT_KIND_META, INCIDENT_KINDS } from '@nodeservice/shared';
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
  it('про самого Джарвиса: память, что записывает, ручной путь смены провайдера', () => {
    const text = referenceById('self')?.render() ?? '';
    expect(text).toContain('Между беседами памяти нет');
    expect(text).toContain('Статьи в базу знаний');
    expect(text).toContain('Хостинг');
    expect(text).toContain('search_audit');
  });
  it('про автопочинку сказано, что «Само» не работает при выключенном общем выключателе', () => {
    expect(referenceById('incidents')?.render()).toContain('даже когда для вида инцидента выбрано «Само»');
  });
  it('история версий: текущая версия первой, новые записи выше старых, видно только последние десять', () => {
    const text = referenceById('changelog')?.render() ?? '';
    expect(text).toMatch(/Текущая версия: \d+\.\d+\.\d+/);
    // Захардкоженные номера версий тут не годятся: справочник показывает только последние 10 записей
    // (CHANGELOG.slice(0, 10)), а список растёт с каждой поставкой — берём границы окна из самого CHANGELOG.
    const [newest, second] = CHANGELOG;
    const lastShown = CHANGELOG[9];
    expect(newest && text.indexOf(`## ${newest.version}`)).toBeGreaterThan(0);
    if (second)
      expect(text.indexOf(`## ${newest?.version}`)).toBeLessThan(text.indexOf(`## ${second.version}`));
    if (lastShown) expect(text).toContain(`## ${lastShown.version}`);
    if (CHANGELOG[10]) expect(text).not.toContain(`## ${CHANGELOG[10].version}`);
  });
  it('про профиль парка: расхождение считается только по ожидаемому, снимок перепроверяют, правила не правит Джарвис', () => {
    const text = referenceById('fleet')?.render() ?? '';
    expect(text).toContain('Расхождением считается только ожидаемое, чего нет');
    expect(text).toContain('snapshotAgeHours');
    expect(text).toContain('inspect_containers');
    expect(text).toContain('Сам ты статью не меняешь');
    expect(text).toContain('profileFilled=false');
    expect(text).toContain('Правила парка');
  });
  it('про изменения по подтверждению: операции, проверка перед применением, откат, что не предлагается', () => {
    const text = referenceById('changes')?.render() ?? '';
    for (const op of [
      'server.provider',
      'server.tags',
      'server.notes',
      'server.rename',
      'server.nodeWatch',
      'server.profile',
      'incident.resolve',
      'autofix.pause',
    ])
      expect(text, op).toContain(op);
    for (const op of ['autofix.policy', 'maintenance.run', 'kb.runbook']) expect(text, op).toContain(op);
    expect(text).toContain('apt upgrade');
    expect(text).toContain('Очистка предлагается от 70 %');
    expect(text).toContain('Состояние изменилось');
    expect(text).toContain('Отменить изменение');
    expect(text).toContain('кнопкой не отменяются');
    expect(text).toContain('Не больше трёх карточек');
    expect(text).toContain('24 ч');
    expect(text).toContain('SSH-ключи');
    expect(text).toContain('пиши «предложил');
  });
  it('про страну сервера: как определяется, пороги, ручной выбор, смена в Журнале, расхождение баз', () => {
    const text = referenceById('fleet')?.render() ?? '';
    expect(text).toContain('Страна сервера');
    expect(text).toContain('не меньше четырёх');
    expect(text).toContain('60 %');
    expect(text).toContain('Ручной выбор автоматика не трогает');
    expect(text).toContain('server.country.changed');
    expect(text).toContain('расхождениями, а не фактом блокировки');
    expect(text).toContain('IP сервера при этом уходит');
  });
  it('про Remnawave: только чтение, как сопоставить ноду с сервером, сертификат важен отдельно', () => {
    const text = referenceById('remnawave')?.render() ?? '';
    expect(text).toContain('get_remnawave_status');
    expect(text).toContain('только чтение');
    expect(text).toContain('сопоставляй по адресу');
    expect(text).toContain('нет прав на запись');
    expect(text).toContain('срочная проблема');
  });
});
