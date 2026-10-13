import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Scenario, type ScenarioRun, scenarioRunSchema, scenariosSchema } from '@nodeservice/shared';
import { eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';

/** Итог шага из текста прежних записей: те же слова, что пишет сценарий. */
function legacyTone(text: string): ScenarioRun['steps'][number]['tone'] {
  if (text === 'TCP доступен' || /возвращён после|уже в исходном/.test(text)) return 'ok';
  if (text.startsWith('TCP: недостаточно')) return 'warn';
  if (/^(Записано в событие|Событие сохранено|Открытого события)/.test(text)) return 'info';
  if (/^(Изменено|Скрыто)/.test(text)) return 'change';
  return 'crit';
}

/** Версия записи сценариев: 2 — с 0.95.0 (ожидание по умолчанию 1 минута); у прежних записей её нет. */
const RULES_VERSION_KEY = '_v';
const RULES_VERSION = 2;

@Injectable()
export class ScenariosStore {
  constructor(@Inject(DB) private db: Db) {}
  scope(panel: string) {
    return createHash('sha256').update(panel).digest('hex');
  }
  async read<T>(key: string): Promise<T | null> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, key) });
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }
  async write(key: string, value: unknown) {
    await this.db
      .insert(appMeta)
      .values({ key, value: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: { value: JSON.stringify(value), updatedAt: new Date() },
      });
  }
  async remove(key: string) {
    await this.db.delete(appMeta).where(eq(appMeta.key, key));
  }
  async list(panel: string | null): Promise<Scenario[]> {
    if (!panel) return [];
    const key = `scenarios.rules.${this.scope(panel)}`;
    const raw = await this.read<Record<string, unknown>>(key);
    const parsed = scenariosSchema.safeParse(raw ?? { items: [] });
    if (!parsed.success) return [];
    // До 0.95.0 «держится» по умолчанию было 5 минут, а новая форма давала 1: сохранённые 5 минут — прежнее
    // значение по умолчанию, переводим один раз. После этого запись с версией — выбранное позже не трогаем.
    if (raw && raw[RULES_VERSION_KEY] !== RULES_VERSION) {
      const items = parsed.data.items.map((r) => (r.holdMinutes === 5 ? { ...r, holdMinutes: 1 } : r));
      await this.write(key, { items, [RULES_VERSION_KEY]: RULES_VERSION });
      return items;
    }
    return parsed.data.items;
  }
  /** Журнал срабатываний: запись на срабатывание, ключ по времени — свежие первыми одним запросом. */
  async addRun(panel: string, run: ScenarioRun) {
    const parsed = scenarioRunSchema.parse(run);
    const prefix = `scenarios.run.${this.scope(panel)}.`;
    await this.write(`${prefix}${String(parsed.t).padStart(15, '0')}.${parsed.id}`, parsed);
    // Старше 30 дней — не нужны: журнал про то, что сценарии делали недавно.
    const cutoff = String(Date.now() - 30 * 86_400_000).padStart(15, '0');
    await this.db.execute(
      sql`DELETE FROM app_meta WHERE key LIKE ${`${prefix}%`} AND key < ${prefix + cutoff}`,
    );
  }
  async runs(panel: string | null, limit = 100): Promise<ScenarioRun[]> {
    if (!panel) return [];
    await this.backfill(panel);
    const rows = await this.db.execute(
      sql`SELECT value FROM app_meta WHERE key LIKE ${`scenarios.run.${this.scope(panel)}.%`} ORDER BY key DESC LIMIT ${limit}`,
    );
    const out: ScenarioRun[] = [];
    for (const row of rows.rows) {
      const parsed = scenarioRunSchema.safeParse(JSON.parse(String(row.value)));
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }
  /**
   * Срабатывания до 0.94.0 (журнала ещё не было) лежат только в событиях «Метрик»: один раз переносим их в журнал,
   * разбирая итог по шагам, — чтобы владелец сразу видел, что сценарии уже делали.
   */
  private async backfill(panel: string) {
    const scope = this.scope(panel);
    const mark = `scenarios.runs-imported.${scope}`;
    if (await this.read(mark)) return;
    const rows = await this.db.execute(
      sql`SELECT value FROM app_meta WHERE key LIKE ${`node.events.${scope}.%`}
        AND value::jsonb->>'type' = 'automation' AND value::jsonb->>'id' LIKE 'scenario:%'
        AND (value::jsonb->>'t')::numeric > ${Date.now() - 30 * 86_400_000}`,
    );
    const rules = await this.list(panel);
    for (const row of rows.rows) {
      try {
        const e = JSON.parse(String(row.value)) as {
          id: string;
          t: number;
          nodeUuid: string;
          nodeName: string;
          title: string;
          summary: string;
        };
        const [, ruleId = '', , runId = e.id] = e.id.split(':');
        const rule = rules.find((r) => r.id === ruleId);
        const restore = /^Host «.*(возвращён|не возвращён|остаётся|уже в исходном)/.test(e.summary);
        const steps = e.summary
          .split('; ')
          .filter(Boolean)
          .map((text) => ({ text, tone: legacyTone(text) }));
        await this.write(`scenarios.run.${scope}.${String(e.t).padStart(15, '0')}.${runId}`, {
          id: runId,
          ruleId,
          ruleName: rule?.name ?? e.title.replace(/^Сценарий · /, ''),
          t: e.t,
          nodeUuid: e.nodeUuid,
          nodeName: e.nodeName,
          kind: restore ? 'restore' : 'run',
          title: restore ? 'Host после восстановления ноды' : 'Сработал',
          steps,
          failed: steps.some((x) => x.tone === 'crit'),
        } satisfies ScenarioRun);
      } catch {
        /* Испорченная запись не мешает остальным. */
      }
    }
    await this.write(mark, true);
  }
  async set(panel: string, items: Scenario[]) {
    const parsed = scenariosSchema.parse({ items });
    if (new Set(parsed.items.map((i) => i.id)).size !== parsed.items.length)
      throw new Error('Повторяющийся идентификатор сценария.');
    await this.write(`scenarios.rules.${this.scope(panel)}`, {
      ...parsed,
      [RULES_VERSION_KEY]: RULES_VERSION,
    });
    return parsed;
  }
}
