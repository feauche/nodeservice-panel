import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { eq } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { AuditService } from '../audit/audit.service.js';
import { KnowledgeRepository } from '../knowledge/knowledge.repository.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { AssistantSettingsStore } from './assistant-settings.store.js';
import { checkReview } from './kb-review.guard.js';
import { LLM_PROVIDER, type LlmProvider } from './llm.provider.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LAST_RUN_KEY = 'kb.review.lastRunAt';
/** Служебный глоссарий не трогаем — он ведётся автоматически. */
const SKIP_TITLES = new Set(['Пояснения']);

const REVIEW_SYSTEM = `Ты — редактор базы знаний панели управления VPN/прокси-серверами. Тебе дают текст одной статьи в Markdown. Аккуратно приведи её в порядок:
- почини артефакты: обрывки HTML, битый markdown, лишние пустые строки, кривые списки и таблицы;
- улучши структуру и понятность — простыми словами, по шагам где уместно;
- СОХРАНИ всю полезную информацию и смысл: ничего важного не удаляй и не выдумывай новых фактов.
Верни ТОЛЬКО итоговый Markdown статьи — без обрамления, без комментариев. Если править нечего — верни ровно: БЕЗ ИЗМЕНЕНИЙ`;

/** Безопасная косметика без потери содержимого: хвостовые пробелы и лишние пустые строки. */
function tidy(content: string): string {
  return content
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Еженедельная ревизия базы знаний (этап D). Раз в неделю проходит по активным статьям и пишет отчёт в Журнал.
 * Статьи, написанные вручную, модель не переписывает — им только убираются лишние пробелы и пустые строки.
 * Остальные (от Ассистента, из сети, из Telegram) модель приводит в порядок, но результат принимается лишь при
 * строгой сверке с исходником (kb-review.guard): ничего не пропало и не выдумано, ответ не оборван.
 * Статья, которую поправили, пока шла ревизия, не трогается. Каждое изменение — версия в истории (можно откатить).
 * Работает, когда у Ассистента задан ключ модели.
 */
@Injectable()
export class KbReviewService {
  private readonly log = new Logger(KbReviewService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly settings: AssistantSettingsStore,
    private readonly knowledge: KnowledgeService,
    private readonly repo: KnowledgeRepository,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** Раз в час проверяем, не пора ли (прошла ли неделя). Реальная работа — раз в неделю. */
  @Interval(60 * 60 * 1000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    try {
      const last = await this.lastRunAt();
      // Первый раз просто заводим отсчёт — чтобы не запускать ревизию сразу после установки.
      if (last === null) {
        await this.setLastRunAt(Date.now());
        return;
      }
      if (Date.now() - last < WEEK_MS) return;
      await this.setLastRunAt(Date.now());
      await this.runReview();
    } catch (err) {
      this.log.warn(`Тик ревизии не удался: ${errMsg(err)}`);
    }
  }

  /** Пройтись по активным статьям и безопасно причесать их; вернуть сводку. */
  async runReview(): Promise<{ reviewed: number; changed: number; skipped: string | null }> {
    const cfg = await this.settings.config();
    if (!cfg) return { reviewed: 0, changed: 0, skipped: 'Ассистент выключен' };

    const docs = (await this.repo.list(undefined, false)).filter(
      (d) => !d.pinned && !SKIP_TITLES.has(d.title),
    );
    let changed = 0;
    let editedMeanwhile = 0;
    let rejected = 0;
    const changedTitles: string[] = [];
    for (const doc of docs) {
      try {
        // Статьи, написанные вручную, модель не переписывает: только безопасная косметика.
        const improved =
          doc.source === 'self' ? null : await this.improve(cfg.apiKey, cfg.model, doc.content, doc.title);
        if (improved === false) rejected += 1;
        const next = improved || tidy(doc.content);
        if (!next || next === doc.content) continue;
        // Статью поправили, пока модель думала (ревизия идёт часами), — не затираем свежую правку.
        const fresh = await this.repo.findById(doc.id);
        if (!fresh || fresh.archived || fresh.content !== doc.content) {
          editedMeanwhile += 1;
          continue;
        }
        await this.knowledge.update(doc.id, { content: next }, { reason: 'review' });
        changed += 1;
        changedTitles.push(doc.title);
      } catch (err) {
        this.log.warn(`Ревизия статьи «${doc.title}» не удалась: ${errMsg(err)}`);
      }
    }
    await this.audit.record({
      action: 'kb.reviewed',
      source: 'auto',
      metadata: {
        reviewed: docs.length,
        changed,
        articles: changedTitles.slice(0, 20),
        ...(rejected ? { rejected } : {}),
        ...(editedMeanwhile ? { editedMeanwhile } : {}),
      },
    });
    return { reviewed: docs.length, changed, skipped: null };
  }

  /**
   * Один осторожный проход модели по статье. Строка — принятый текст; null — менять нечего;
   * false — ответ отвергнут предохранителем (оборван, что-то потеряно или выдумано).
   */
  private async improve(
    apiKey: string,
    model: string,
    content: string,
    title: string,
  ): Promise<string | null | false> {
    const res = await this.llm.run({
      apiKey,
      model,
      system: REVIEW_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: content }] }],
      tools: [],
    });
    const text = res.blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!text || text.includes('БЕЗ ИЗМЕНЕНИЙ')) return null;
    if (res.truncated) {
      this.log.warn(`Ревизия статьи «${title}» отвергнута: ответ модели оборван на пределе длины`);
      return false;
    }
    const verdict = checkReview(content, text);
    if (!verdict.ok) {
      this.log.warn(`Ревизия статьи «${title}» отвергнута: ${verdict.why}`);
      return false;
    }
    return verdict.text;
  }

  private async lastRunAt(): Promise<number | null> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, LAST_RUN_KEY) });
    if (!row) return null;
    const at = Number(JSON.parse(row.value)?.at);
    return Number.isFinite(at) ? at : null;
  }

  private async setLastRunAt(at: number): Promise<void> {
    const value = JSON.stringify({ at });
    await this.db
      .insert(appMeta)
      .values({ key: LAST_RUN_KEY, value })
      .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } });
  }
}
