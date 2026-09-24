import { describe, expect, it } from 'vitest';

import { ACTION_SPECS, SH } from './actions.registry.js';

/** Одинарная кавычка в теле рвёт `sh -c '…'`: шелл получает мусор и отвечает 127. */
describe('actions.registry', () => {
  it('SH экранирует одинарные кавычки внутри тела', () => {
    expect(SH("echo 'привет'")).toBe(`sh -c 'echo '\\''привет'\\'''`);
    expect(SH('echo "привет"')).toBe(`sh -c 'echo "привет"'`);
  });

  it('все команды реестра — корректно закрытая строка sh -c', () => {
    for (const [key, spec] of Object.entries(ACTION_SPECS)) {
      const cmd = spec?.command;
      if (!cmd) continue;
      expect(cmd.startsWith("sh -c '"), key).toBe(true);
      expect(cmd.endsWith("'"), key).toBe(true);
      // Внутри обёртки все кавычки идут только в виде '\'' — иначе строка закроется раньше времени.
      const body = cmd.slice(7, -1);
      expect(body.replaceAll(`'\\''`, ''), key).not.toContain("'");
    }
  });
});
