import { EventEmitter } from 'node:events';
import { Injectable } from '@nestjs/common';
import type { AssistantActivity, Notification } from '@nodeservice/shared';

/**
 * Живые события панели для браузера (SSE). Сервер шлёт только при изменениях, браузер перечитывает
 * лишь затронутое — дешевле опроса раз в 15 с. In-memory, один процесс API.
 */
export type PanelEvent =
  | { type: 'notification'; data: Notification }
  | { type: 'server'; data: { id: string } }
  | { type: 'incident'; data: { id: string } }
  /** Сервер переименован: имена в инцидентах и уведомлениях изменились — браузеру перечитать всё. */
  | { type: 'rename'; data: { id: string } }
  /** Джарвис делает что-то долгое (проверка сервера): живая строка в чате. */
  | { type: 'assistant'; data: { conversationId: string; activity: AssistantActivity } };

@Injectable()
export class EventsService {
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
}
