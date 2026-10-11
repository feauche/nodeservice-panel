import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../auth/session.store.js';
import type { SessionChannelsService } from '../auth/session-channels.service.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';

describe('events stream lifecycle', () => {
  it('completes all live streams before shutdown and drops their listeners', () => {
    const events = new EventsService();
    const revoked = new Subject<void>();
    const controller = new EventsController(events, {
      revoked: () => revoked.asObservable(),
    } as unknown as SessionChannelsService);
    const first = vi.fn();
    const second = vi.fn();
    const complete = vi.fn();
    const session = { id: 'local-session' } as SessionRecord;
    controller.stream(session).subscribe({ next: first, complete });
    controller.stream(session).subscribe({ next: second, complete });
    events.emit({ type: 'server', data: { id: 'node-1' } });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    events.beforeApplicationShutdown();
    expect(complete).toHaveBeenCalledTimes(2);
    events.emit({ type: 'server', data: { id: 'node-2' } });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    const afterShutdown = vi.fn();
    controller.stream(session).subscribe({ complete: afterShutdown });
    expect(afterShutdown).toHaveBeenCalledOnce();
  });
});
