import { GoneException, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ActionKey } from '@nodeservice/shared';
import type { IncidentRow } from '../../infra/db/schema/index.js';
import { IncidentsRepository } from './incidents.repository.js';
/** Compatibility for historical incident callers; no SSH or executable actions remain. */
@Injectable()
export class IncidentRunnerService implements OnModuleInit {
  constructor(private readonly repo: IncidentsRepository) {}
  async onModuleInit() {
    for (const row of await this.repo.withRunningAttempts())
      await this.cancelRunning(row.id, 'Автопочинка удалена из панели');
  }
  async cancelRunning(id: string, note: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row) return;
    await this.repo.update(id, {
      proposal: null,
      attempts: row.attempts.map((a) =>
        a.status === 'running'
          ? {
              ...a,
              status: 'failed' as const,
              finishedAt: new Date().toISOString(),
              steps: a.steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed' as const } : s)),
            }
          : a,
      ),
      timeline: row.attempts.some((a) => a.status === 'running')
        ? [
            ...row.timeline,
            {
              at: new Date().toISOString(),
              by: 'auto',
              action: note,
              result: 'detect',
            },
          ]
        : row.timeline,
    });
  }
  async start(_id: string, _key: ActionKey, _by: 'auto' | 'manual'): Promise<IncidentRow> {
    throw new GoneException('Автопочинка удалена. Панель только наблюдает за нодами.');
  }
}
