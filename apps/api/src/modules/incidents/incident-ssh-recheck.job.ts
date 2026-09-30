import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { ServersRepository } from '../servers/servers.repository.js';
import { ServersService } from '../servers/servers.service.js';
import { IncidentsRepository } from './incidents.repository.js';
import { PARTIAL_MARK } from './incidents.service.js';

/** Пока «SSH недоступен» открыт, не ждём обычного интервала автопроверки (может быть час): перепроверяем чаще. */
const RECHECK_INTERVAL_MS = 20_000;
/** Не чаще этого между настоящими SSH-подключениями к одному серверу, даже если тиков было несколько. */
const MIN_GAP_MS = 15_000;

/**
 * Пока у сервера открыт инцидент «SSH недоступен», обычная автопроверка SSH (раз в 15–60 минут, смотря
 * что в настройках) слишком редкая: доступ мог вернуться уже через минуту. Эта джоба, пока такой
 * инцидент открыт, гоняет ту же проверку куда чаще — инцидент закрывается сам, как только связь пришла,
 * а не только по кнопке «Проверить все».
 *
 * Она же подтверждает неудачу до того, как дело заведено: SSH один раз не ответил — перепроверяем сразу,
 * а не через час. Прошла проверка — тревоги не было; не проходят дольше порога — детекция открывает
 * «SSH недоступен» (см. IncidentsService.sshDownConfirmed).
 */
@Injectable()
export class IncidentSshRecheckJob {
  private readonly log = new Logger(IncidentSshRecheckJob.name);
  private busy = false;

  constructor(
    private readonly incidentsRepo: IncidentsRepository,
    private readonly serversRepo: ServersRepository,
    private readonly servers: ServersService,
  ) {}

  @Interval(RECHECK_INTERVAL_MS)
  async tick(): Promise<void> {
    // В e2e джобы не тикают сами — тесты вызывают run() напрямую (детерминизм).
    if (process.env.NODE_ENV === 'test') return;
    await this.run();
  }

  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const open = await this.incidentsRepo.list('open');
      const serverIds = new Set(
        open
          .filter((i) => (i.kind === 'ssh_down' || i.kind === 'server_down') && i.serverId)
          .map((i) => i.serverId as string),
      );
      // SSH не ответил, а дела ещё нет — неудачу нужно подтвердить или снять. Сервер с открытым делом
      // «Недоступен из части сетей» не трогаем: там молчание SSH уже объяснено, хватит обычной автопроверки.
      const explained = new Set(
        open
          .filter((i) => i.kind === 'node_blocked' && i.detail.startsWith(PARTIAL_MARK))
          .map((i) => i.serverId),
      );
      for (const s of await this.serversRepo.list())
        if (s.sshOk === false && !explained.has(s.id)) serverIds.add(s.id);
      if (serverIds.size === 0) return;
      const now = Date.now();
      for (const id of serverIds) {
        const row = await this.serversRepo.findById(id);
        if (!row) continue;
        if (row.lastSshCheckAt && now - row.lastSshCheckAt.getTime() < MIN_GAP_MS) continue;
        await this.servers.autocheck(row).catch((err) => {
          this.log.debug(`Перепроверка SSH при открытом инциденте (${row.name}): ${(err as Error).message}`);
        });
      }
    } catch (err) {
      this.log.warn(`Ускоренная перепроверка SSH споткнулась: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
