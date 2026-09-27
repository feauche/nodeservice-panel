import { beforeEach, describe, expect, it } from 'vitest';

import type { GeoAnswers } from './geo.lookup.js';
import { ServerCountryService } from './server-country.service.js';

interface Row {
  id: string;
  name: string;
  host: string;
  country: string | null;
  countrySource: string;
  countryStatus: string;
  countryAgree: number | null;
  countryTotal: number | null;
  countryCheckedAt: Date | null;
  countryNote: string | null;
  countryCandidate: string | null;
  countryCandidateCount: number;
}

const row = (over: Partial<Row> = {}): Row => ({
  id: 's1',
  name: 'bridge',
  host: '104.171.133.254',
  country: null,
  countrySource: 'auto',
  countryStatus: 'none',
  countryAgree: null,
  countryTotal: null,
  countryCheckedAt: null,
  countryNote: null,
  countryCandidate: null,
  countryCandidateCount: 0,
  ...over,
});

function make(initial: Row) {
  const rows = new Map<string, Row>([[initial.id, initial]]);
  const audit: Array<Record<string, unknown>> = [];
  const world = {
    answers: ['PL', 'PL', 'PL', 'PL', 'BR', 'RU'] as string[],
    problem: undefined as string | undefined,
    /** Что сделать во время запроса к геосервисам (человек успел выбрать вручную и т. п.). */
    during: null as null | (() => void),
    throwOnDetect: false,
    calls: 0,
  };
  const repo = {
    findById: async (id: string) => {
      const r = rows.get(id);
      return r ? { ...r } : undefined;
    },
    update: async (id: string, patch: Partial<Row>) => {
      const r = rows.get(id);
      if (r) Object.assign(r, patch);
      return r;
    },
  };
  const geo = {
    detect: async (): Promise<GeoAnswers> => {
      world.calls += 1;
      world.during?.();
      if (world.throwOnDetect) throw new Error('сеть упала');
      return {
        ip: '104.171.133.254',
        answers: world.answers,
        asked: 7,
        ...(world.problem ? { problem: world.problem } : {}),
      };
    },
  };
  const svc = new ServerCountryService(
    repo as never,
    { record: async (e: Record<string, unknown>) => void audit.push(e) } as never,
    geo as never,
  );
  return { svc, rows, audit, world, cur: () => rows.get(initial.id) as Row };
}

describe('ServerCountryService', () => {
  let ctx: ReturnType<typeof make>;
  beforeEach(() => {
    ctx = make(row({ countryStatus: 'detecting' }));
  });

  it('первое определение: страна, доля согласных, запись в Журнал «определена»', async () => {
    await ctx.svc.detect('s1', { scheduled: false });
    expect(ctx.cur()).toMatchObject({
      country: 'PL',
      countryStatus: 'ok',
      countryAgree: 4,
      countryTotal: 6,
      countryNote: null,
    });
    expect(ctx.cur().countryCheckedAt).toBeInstanceOf(Date);
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0]).toMatchObject({
      action: 'server.country.detected',
      severity: 'info',
      source: 'auto',
      target: { type: 'server', id: 's1', display: 'bridge' },
      metadata: { to: 'PL', toName: 'Польша', agree: 4, total: 6 },
    });
  });

  it('не хватает ответивших или источники разошлись: «не удалось», причина в примечании', async () => {
    ctx.world.answers = ['PL', 'PL'];
    await ctx.svc.detect('s1', { scheduled: false });
    expect(ctx.cur()).toMatchObject({ country: null, countryStatus: 'failed' });
    expect(ctx.cur().countryNote).toContain('Ответили только 2');
    ctx.world.answers = ['PL', 'PL', 'BR', 'BR', 'RU'];
    await ctx.svc.detect('s1', { scheduled: false });
    expect(ctx.cur().countryNote).toContain('PL 2, BR 2, RU 1');
    expect(ctx.audit).toHaveLength(0);
  });

  it('адрес не публичный: причина от геосервиса попадает в примечание', async () => {
    ctx.world.problem = 'Адрес 10.0.0.5 не публичный: страну по нему определить нельзя.';
    ctx.world.answers = [];
    await ctx.svc.detect('s1', { scheduled: false });
    expect(ctx.cur()).toMatchObject({
      countryStatus: 'failed',
      countryNote: ctx.world.problem,
      countryAgree: null,
    });
  });

  it('вручную выбранную страну автоматика не трогает и наружу не ходит', async () => {
    ctx = make(row({ country: 'NL', countrySource: 'manual', countryStatus: 'ok' }));
    await ctx.svc.detect('s1', { scheduled: true });
    await ctx.svc.detect('s1', { scheduled: false });
    expect(ctx.cur()).toMatchObject({ country: 'NL', countrySource: 'manual' });
    expect(ctx.world.calls).toBe(0);
  });

  it('человек выбрал вручную, пока шёл запрос: результат отбрасывается', async () => {
    ctx.world.during = () =>
      Object.assign(ctx.cur(), { country: 'NL', countrySource: 'manual', countryStatus: 'ok' });
    await ctx.svc.detect('s1', { scheduled: false });
    expect(ctx.cur()).toMatchObject({ country: 'NL', countrySource: 'manual' });
    expect(ctx.audit).toHaveLength(0);
  });

  it('по просьбе человека другая страна применяется сразу и попадает в Журнал как смена', async () => {
    ctx = make(row({ country: 'RU', countryStatus: 'detecting' }));
    await ctx.svc.detect('s1', { scheduled: false });
    expect(ctx.cur()).toMatchObject({ country: 'PL', countryStatus: 'ok' });
    expect(ctx.audit[0]).toMatchObject({
      action: 'server.country.changed',
      severity: 'warn',
      metadata: { from: 'RU', fromName: 'Россия', to: 'PL', toName: 'Польша' },
    });
  });

  it('плановая проверка: другая страна применяется после двух подтверждений подряд', async () => {
    ctx = make(row({ country: 'RU', countryStatus: 'ok', countryCheckedAt: new Date(0) }));
    await ctx.svc.detect('s1', { scheduled: true });
    expect(ctx.cur()).toMatchObject({ country: 'RU', countryCandidate: 'PL', countryCandidateCount: 1 });
    expect(ctx.audit).toHaveLength(0);
    await ctx.svc.detect('s1', { scheduled: true });
    expect(ctx.cur()).toMatchObject({
      country: 'PL',
      countryCandidate: null,
      countryCandidateCount: 0,
      countryStatus: 'ok',
    });
    expect(ctx.audit.map((a) => a.action)).toEqual(['server.country.changed']);
  });

  it('другая страна в одной проверке и прежняя в следующей: кандидат сбрасывается, смены нет', async () => {
    ctx = make(row({ country: 'RU', countryStatus: 'ok', countryCheckedAt: new Date(0) }));
    await ctx.svc.detect('s1', { scheduled: true });
    expect(ctx.cur().countryCandidateCount).toBe(1);
    ctx.world.answers = ['RU', 'RU', 'RU', 'RU', 'PL'];
    await ctx.svc.detect('s1', { scheduled: true });
    expect(ctx.cur()).toMatchObject({ country: 'RU', countryCandidate: null, countryCandidateCount: 0 });
    expect(ctx.audit).toHaveLength(0);
  });

  it('разные кандидаты подряд не складываются', async () => {
    ctx = make(row({ country: 'RU', countryStatus: 'ok', countryCheckedAt: new Date(0) }));
    await ctx.svc.detect('s1', { scheduled: true });
    ctx.world.answers = ['DE', 'DE', 'DE', 'DE', 'PL'];
    await ctx.svc.detect('s1', { scheduled: true });
    expect(ctx.cur()).toMatchObject({ country: 'RU', countryCandidate: 'DE', countryCandidateCount: 1 });
  });

  it('плановая проверка без ответа не стирает прежний результат, а по просьбе человека даёт «не удалось»', async () => {
    ctx = make(row({ country: 'PL', countryStatus: 'ok', countryCheckedAt: new Date(0) }));
    ctx.world.answers = [];
    await ctx.svc.detect('s1', { scheduled: true });
    expect(ctx.cur()).toMatchObject({ country: 'PL', countryStatus: 'ok' });
    expect((ctx.cur().countryCheckedAt as Date).getTime()).toBeGreaterThan(0);
    await ctx.svc.detect('s1', { scheduled: false });
    expect(ctx.cur()).toMatchObject({ country: 'PL', countryStatus: 'failed' });
  });

  it('ошибка панели во время запроса не оставляет вечное «определяется»', async () => {
    ctx.world.throwOnDetect = true;
    await expect(ctx.svc.detect('s1', { scheduled: false })).rejects.toThrow('сеть упала');
    expect(ctx.cur().countryStatus).toBe('failed');
    ctx = make(row({ country: 'PL', countryStatus: 'detecting' }));
    ctx.world.throwOnDetect = true;
    await expect(ctx.svc.detect('s1', { scheduled: false })).rejects.toThrow();
    expect(ctx.cur()).toMatchObject({ country: 'PL', countryStatus: 'ok' });
  });

  it('два запуска одновременно: определение идёт один раз', async () => {
    await Promise.all([
      ctx.svc.detect('s1', { scheduled: false }),
      ctx.svc.detect('s1', { scheduled: false }),
    ]);
    expect(ctx.world.calls).toBe(1);
  });

  it('сервера уже нет: тихо выходит', async () => {
    ctx.rows.clear();
    await expect(ctx.svc.detect('s1', { scheduled: true })).resolves.toBeUndefined();
  });
});
