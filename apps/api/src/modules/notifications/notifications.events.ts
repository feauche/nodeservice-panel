import { EventEmitter } from 'node:events';
import { Injectable } from '@nestjs/common';
import type { Notification } from '@nodeservice/shared';

/** Шина «уведомление создано» — для SSE колокольчика. In-memory, один процесс API (как AuditEvents). */
@Injectable()
export class NotificationsEvents {
  private readonly emitter = new EventEmitter({ captureRejections: false });

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(n: Notification): void {
    this.emitter.emit('created', n);
  }

  on(listener: (n: Notification) => void): () => void {
    this.emitter.on('created', listener);
    return () => this.emitter.off('created', listener);
  }
}
