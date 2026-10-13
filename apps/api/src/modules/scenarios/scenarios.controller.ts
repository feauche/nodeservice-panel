import { BadRequestException, Body, Controller, Get, Inject, Put, Query } from '@nestjs/common';
import {
  journalPage,
  scenarioJournalQuerySchema,
  scenarioOverview,
  scenariosSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';
import { DEFAULT_TIME_ZONE, panelTimeZone } from '../../common/panel-time-zone.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { Audit } from '../audit/audit.decorator.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { ScenariosJob } from './scenarios.job.js';
import { ScenariosStore } from './scenarios.store.js';

class Dto extends createZodDto(scenariosSchema) {}
class JournalQueryDto extends createZodDto(scenarioJournalQuerySchema) {}
/** Сколько срабатываний читать для журнала — 30 дней с запасом (обычно десятки в сутки). */
const JOURNAL_MAX = 5000;
@Controller('scenarios')
export class ScenariosController {
  constructor(
    private store: ScenariosStore,
    private remna: RemnawaveService,
    private job: ScenariosJob,
    @Inject(DB) private db: Db,
  ) {}
  @Get() async get() {
    const st = await this.remna.status();
    return { items: await this.store.list(st.domain) };
  }
  /** Журнал срабатываний для страницы «Сценарии»: последние 100, свежие первыми. */
  @Get('runs') async runs() {
    const st = await this.remna.status();
    return { items: await this.store.runs(st.domain) };
  }
  /**
   * Журнал порциями — внутри сценария (`rule`) или по всем: по ноде, за период, по итогам, с курсором следующей
   * порции, числами по итогам и полоской последних 20 срабатываний. Хранятся 30 дней.
   */
  @Get('journal') async journal(@Query() q: JournalQueryDto) {
    const st = await this.remna.status();
    const timeZone = (await panelTimeZone(this.db)) ?? DEFAULT_TIME_ZONE;
    return journalPage(await this.store.runs(st.domain, JOURNAL_MAX), q, Date.now(), timeZone);
  }
  /**
   * Сводка для списка: включено, за сутки (по 2 часа), за неделю с замечаниями, сколько Host помечено сейчас; по
   * каждому сценарию — последнее срабатывание, числа и полоска последних 20.
   */
  @Get('overview') async overview() {
    const st = await this.remna.status();
    const [rules, runs, marked, timeZone] = await Promise.all([
      this.store.list(st.domain),
      this.store.runs(st.domain, JOURNAL_MAX),
      this.store.markedHosts(st.domain),
      panelTimeZone(this.db),
    ]);
    return scenarioOverview(rules, runs, marked, Date.now(), timeZone ?? DEFAULT_TIME_ZONE);
  }
  @Get('hosts') async hosts() {
    try {
      return await this.job.previewHosts();
    } catch {
      throw new BadRequestException(
        'Не удалось прочитать Host. Проверьте подключение и разрешение API-ключа на чтение Host.',
      );
    }
  }
  @Put() @Audit('settings.scenarios.updated') async set(@Body() body: Dto) {
    const st = await this.remna.status();
    if (!st.domain) throw new BadRequestException('Подключите Remnawave.');
    const ids = new Set(st.nodes.map((n) => n.uuid));
    if (body.items.some((r) => r.nodes.some((n) => !ids.has(n))))
      throw new BadRequestException('Выбранная нода больше не существует в подключении.');
    if (new Set(body.items.map((r) => r.id)).size !== body.items.length)
      throw new BadRequestException('Сценарии не должны повторяться.');
    if (
      body.items.some((r) =>
        r.hostBindings.some(
          (b) => !ids.has(b.nodeUuid) || (r.scope === 'selected' && !r.nodes.includes(b.nodeUuid)),
        ),
      )
    )
      throw new BadRequestException('Host должен быть назначен ноде в области действия сценария.');
    if (body.items.some((r) => r.hostBindings.length)) {
      const { hosts } = await this.job.previewHosts();
      if (
        body.items.some((r) =>
          r.hostBindings.some(
            (b) =>
              !hosts.some(
                (h) =>
                  h.uuid === b.hostUuid &&
                  (h.nodes.length === 0 || (h.nodes.length === 1 && h.nodes[0] === b.nodeUuid)),
              ),
          ),
        )
      )
        throw new BadRequestException(
          'Host отсутствует или связан с несколькими нодами. Обновите список Host.',
        );
    }
    return this.store.set(st.domain, body.items);
  }
}
