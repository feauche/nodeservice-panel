import { EventEmitter } from 'node:events';
import { Injectable } from '@nestjs/common';
import type { AuditEntry } from '@nodeservice/shared';

/**
 * Шина «запись Журнала создана» — для SSE-ленты. Один процесс API, поэтому in-memory;
 * при горизонтальном масштабировании заменяется на LISTEN/NOTIFY (интерфейс тот же).
 */
@Injectable()
export class AuditEvents {
  private readonly emitter = new EventEmitter({ captureRejections: false });

  constructor() {
    // Каждая открытая SSE-вкладка — слушатель; лимит по умолчанию (10) здесь не нужен.
    this.emitter.setMaxListeners(0);
  }

  emitCreated(entry: AuditEntry): void {
    this.emitter.emit('created', entry);
  }

  /** Подписка; возвращает функцию отписки. */
  onCreated(listener: (entry: AuditEntry) => void): () => void {
    this.emitter.on('created', listener);
    return () => this.emitter.off('created', listener);
  }

  get listenerCount(): number {
    return this.emitter.listenerCount('created');
  }
}
