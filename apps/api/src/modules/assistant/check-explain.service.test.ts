import { describe, expect, it } from 'vitest';

import { checkExplainSystem } from './check-explain.service.js';

describe('checkExplainSystem: правила пересказа проверки', () => {
  const system = checkExplainSystem('новичок');

  it('отменённый запуск: скрипт закреплён по коммиту — «у автора обновилось» не причина; подмена — гипотеза', () => {
    expect(system).not.toMatch(/обновят проверенную версию|изменился у автора/);
    expect(system).toContain('новая версия у автора сюда не попадает');
    expect(system).toContain('файл могли подменить по дороге к серверу или там, где он хранится');
    expect(system).toContain('Само не пройдёт');
  });

  it('полный замер: баллы Geekbench 4 не сравниваются с баллами шестой версии', () => {
    expect(system).toContain('Geekbench 4');
    expect(system).toContain('не сравнивай с баллами Geekbench 5 и 6');
  });
});
