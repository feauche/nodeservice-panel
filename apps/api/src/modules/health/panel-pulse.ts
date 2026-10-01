import { Injectable } from '@nestjs/common';

/**
 * Отметки живости фоновых задач — для /api/health/ready. Главная задача — поиск инцидентов (раз в 30 с):
 * пока она не отрабатывает, панель не замечает сбоев на серверах, хотя сама отвечает. Отметку ставит только
 * удачный проход; зависший или падающий раз за разом проход её не обновляет.
 */
@Injectable()
export class PanelPulse {
  /** С какого момента считать молчание, пока удачных проходов ещё не было (запуск панели). */
  startedAt = Date.now();
  private incidentsAt: number | null = null;

  /** Поиск инцидентов отработал без ошибки. */
  incidentsTick(at = Date.now()): void {
    this.incidentsAt = at;
  }

  /** Сколько поиск инцидентов молчит: от последнего удачного прохода, а если его не было — от запуска. */
  incidentsSilentMs(now = Date.now()): number {
    return Math.max(0, now - (this.incidentsAt ?? this.startedAt));
  }
}
