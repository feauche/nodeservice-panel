import { ASSISTANT_PERMISSIONS_DEFAULT } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';
import { buildSystem } from './assistant.prompt.js';

describe('current passive Remnawave assistant prompt', () => {
  it('describes current node tools and does not offer removed actions even with old permissions enabled', () => {
    const text = buildSystem('intermediate', ASSISTANT_PERMISSIONS_DEFAULT);
    expect(text).toContain('get_node_detail');
    expect(text).toContain('get_node_metrics');
    expect(text).toContain('КАРТА ПАНЕЛИ');
    for (const old of [
      'inspect_processes',
      'run_server_check',
      'save_kb_article',
      'add_glossary_terms',
      'Установить агента',
      'get_server_detail',
      'autofix.pause',
    ])
      expect(text).not.toContain(old);
    expect(text).toContain('null, пропуск и ошибка означают неизвестное');
    expect(text).toContain('не расширяют текущий режим чтения');
  });
  it('preserves owner rules, response detail, provenance and actual panel address', () => {
    const text = buildSystem('pro', ASSISTANT_PERMISSIONS_DEFAULT, {
      fleetRules: 'CPU до 60 %.',
      panelUrl: 'https://panel.test',
    });
    expect(text).toContain('CPU до 60 %.');
    expect(text).toContain('«КРАТКО»');
    expect(text).toContain('https://panel.test');
    expect(text).toContain('возможно, устарело');
    expect(buildSystem('novice', ASSISTANT_PERMISSIONS_DEFAULT)).toContain('«ПОДРОБНО»');
    expect(buildSystem('intermediate', ASSISTANT_PERMISSIONS_DEFAULT)).not.toContain('АДРЕС ЭТОЙ ПАНЕЛИ');
  });
});
