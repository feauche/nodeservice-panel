import { isAnalysisStale } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_TOOLS,
  ASK_TOOLS,
  analysisSystem,
  parseSubmission,
  pickAutoAnalysis,
  stepLabel,
} from './incident-analysis.logic.js';

const good = {
  verdict: 'Диск занят временными файлами.',
  confidence: 'high',
  evidence: [{ source: 'inspect', text: '27 ГБ в /tmp.' }],
};

describe('parseSubmission', () => {
  it('принимает верный разбор и оставляет шаг из цепочки вида', () => {
    const r = parseSubmission({ ...good, nextAction: 'tmp_clean' }, 'disk_high');
    expect(r.ok && r.value.nextAction).toBe('tmp_clean');
  });
  it('шаг из чужой цепочки или выдуманный отбрасывает, разбор остаётся', () => {
    for (const nextAction of ['reboot', 'rm_rf', 'node_up', ''])
      expect(parseSubmission({ ...good, nextAction }, 'disk_high')).toMatchObject({
        ok: true,
        value: { nextAction: null },
      });
  });
  it('неизвестный источник становится «other», пустое «unknown» — null', () => {
    const r = parseSubmission(
      { ...good, unknown: '', evidence: [{ source: 'lsof', text: 'x' }] },
      'cpu_high',
    );
    expect(r.ok && r.value.evidence[0]?.source).toBe('other');
    expect(r.ok && r.value.unknown).toBeNull();
  });
  it('пустой вывод, нет доказательств и неверная уверенность — ошибка с подсказкой для модели', () => {
    for (const bad of [
      { ...good, verdict: '' },
      { ...good, evidence: [] },
      { ...good, confidence: 'absolute' },
      {},
      null,
    ]) {
      const r = parseSubmission(bad, 'disk_high');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('submit_analysis');
    }
  });
  it('слишком длинный вывод отклоняется', () => {
    expect(parseSubmission({ ...good, verdict: 'а'.repeat(701) }, 'disk_high').ok).toBe(false);
  });
});

describe('инструменты и промпты разбора', () => {
  it('в разборе только чтение и сдача: никаких действий и записей', () => {
    const names = ANALYSIS_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'check_reachability',
        'get_incident',
        'get_maintenance',
        'get_metrics_history',
        'get_playbook',
        'get_server_detail',
        'inspect_node_logs',
        'inspect_processes',
        'list_incidents',
        'submit_analysis',
      ].sort(),
    );
    expect(ASK_TOOLS.map((t) => t.name)).not.toContain('submit_analysis');
    for (const banned of ['propose_action', 'save_kb_article', 'add_glossary_terms'])
      expect(names).not.toContain(banned);
  });
  it('системный промпт содержит защиту от инструкций из данных и запрет запуска', () => {
    const s = analysisSystem('novice');
    expect(s).toContain('не инструкции');
    expect(s).toContain('Ты ничего не запускаешь');
  });
  it('подписи шагов понятны', () => {
    expect(stepLabel('get_metrics_history', { metric: 'diskPct' }, 'disk_high')).toBe('Смотрю историю: диск');
    expect(stepLabel('get_metrics_history', { metric: 'memPct' }, 'mem_high')).toBe('Смотрю историю: память');
    expect(stepLabel('submit_analysis', {}, 'disk_high')).toBe('Формулирую вывод');
  });
});

describe('isAnalysisStale', () => {
  const a = (over = {}) =>
    ({
      status: 'done',
      basedOn: { attempts: 1, resolved: false },
      ...over,
    }) as Parameters<typeof isAnalysisStale>[0];
  it('устаревает от новых попыток и от закрытия', () => {
    expect(isAnalysisStale(a(), { attempts: 1, resolved: false })).toBe(false);
    expect(isAnalysisStale(a(), { attempts: 2, resolved: false })).toBe(true);
    expect(isAnalysisStale(a(), { attempts: 1, resolved: true })).toBe(true);
  });
  it('идущий и оборванный разбор не «устаревают»', () => {
    expect(isAnalysisStale(a({ status: 'running' }), { attempts: 5, resolved: true })).toBe(false);
    expect(isAnalysisStale(a({ status: 'failed' }), { attempts: 5, resolved: true })).toBe(false);
  });
});

describe('pickAutoAnalysis', () => {
  const NOW = Date.parse('2026-09-26T12:00:00.000Z');
  const inc = (id: string, agoMin: number, over: Record<string, unknown> = {}) => ({
    id,
    status: 'open' as const,
    severity: 'crit' as const,
    openedAt: new Date(NOW - agoMin * 60_000).toISOString(),
    analysis: null,
    ...over,
  });
  it('ждёт паузу автопочинки: свежий инцидент моложе минуты не берётся', () => {
    expect(pickAutoAnalysis([inc('a', 0.5), inc('b', 2)], NOW, 0, 60_000)).toEqual(['b']);
  });
  it('пропускает закрытые, уже разобранные и слишком старые', () => {
    const items = [
      inc('closed', 5, { status: 'resolved' }),
      inc('done', 5, { analysis: { status: 'done' } }),
      inc('old', 7 * 60),
      inc('ok', 5),
    ];
    expect(pickAutoAnalysis(items as never, NOW, 0, 60_000)).toEqual(['ok']);
  });
  it('не больше пяти в час с учётом уже запущенных; сначала самые давние', () => {
    const items = Array.from({ length: 8 }, (_, i) => inc(`i${i}`, 10 + i));
    expect(pickAutoAnalysis(items, NOW, 0, 60_000)).toEqual(['i7', 'i6', 'i5', 'i4', 'i3']);
    expect(pickAutoAnalysis(items, NOW, 3, 60_000)).toEqual(['i7', 'i6']);
    expect(pickAutoAnalysis(items, NOW, 5, 60_000)).toEqual([]);
  });
});
