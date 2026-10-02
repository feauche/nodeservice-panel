import { Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';

/** Живые WebSocket/SSE-каналы браузера, привязанные к session id. */
@Injectable()
export class SessionChannelsService {
  private readonly listeners = new Map<string, Set<() => void>>();

  register(sessionId: string, close: () => void): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<() => void>();
    set.add(close);
    this.listeners.set(sessionId, set);
    return () => {
      set.delete(close);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }

  revoked(sessionId: string): Observable<void> {
    return new Observable<void>((subscriber) =>
      this.register(sessionId, () => {
        subscriber.next();
        subscriber.complete();
      }),
    );
  }

  revoke(sessionIds: Iterable<string>): void {
    for (const id of sessionIds) {
      const listeners = [...(this.listeners.get(id) ?? [])];
      this.listeners.delete(id);
      for (const close of listeners) close();
    }
  }
}
