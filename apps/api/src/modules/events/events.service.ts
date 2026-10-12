import { EventEmitter } from 'node:events';
import { type BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { ReplaySubject } from 'rxjs';

/**
 * Живые события панели для браузера (SSE). Сервер шлёт только при изменениях, браузер перечитывает
 * лишь затронутое — дешевле опроса раз в 15 с. In-memory, один процесс API.
 */
export type PanelEvent = { type: 'incident'; data: { id: string } };

@Injectable()
export class EventsService implements BeforeApplicationShutdown {
  private readonly shutdown = new ReplaySubject<void>(1);
  readonly shutdown$ = this.shutdown.asObservable();
  private readonly emitter = new EventEmitter({ captureRejections: false });

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(event: PanelEvent): void {
    this.emitter.emit('event', event);
  }

  on(listener: (e: PanelEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
  /** Закрываем SSE до остановки HTTP-сервера, иначе живые вкладки удерживают restart. */
  beforeApplicationShutdown(): void {
    this.shutdown.next();
    this.shutdown.complete();
  }
}
