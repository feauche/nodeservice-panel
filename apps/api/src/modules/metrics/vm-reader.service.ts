import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema.js';

export interface VmMatrixSeries {
  labels: Record<string, string>;
  points: Array<[number, number]>;
}

/**
 * Чтение из VictoriaMetrics (PromQL). Недоступная VM — не ошибка панели:
 * методы возвращают null, а страницы показывают честные пустые состояния.
 */
@Injectable()
export class VmReaderService {
  private readonly log = new Logger(VmReaderService.name);
  private readonly url: string;
  private lastErrorAt = 0;

  constructor(config: ConfigService<Env, true>) {
    this.url = config.get('VM_URL');
  }

  /** Мгновенный запрос: вектор «последних» значений. */
  async query(promql: string): Promise<VmMatrixSeries[] | null> {
    return this.call('/api/v1/query', { query: promql });
  }

  async queryRange(promql: string, startSec: number, endSec: number, stepSec: number) {
    return this.call('/api/v1/query_range', {
      query: promql,
      start: String(startSec),
      end: String(endSec),
      step: String(stepSec),
    });
  }

  private async call(path: string, params: Record<string, string>): Promise<VmMatrixSeries[] | null> {
    try {
      const res = await fetch(`${this.url}${path}?${new URLSearchParams(params)}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`VM ответила ${res.status}`);
      const body = (await res.json()) as {
        status: string;
        data?: { result?: Array<{ metric: Record<string, string>; values?: unknown[]; value?: unknown[] }> };
      };
      if (body.status !== 'success') throw new Error('VM: status != success');
      return (body.data?.result ?? []).map((r) => ({
        labels: r.metric,
        points: (r.values ?? (r.value ? [r.value] : [])).map((pair) => {
          const [t, v] = pair as [number, string];
          return [Number(t), Number(v)] as [number, number];
        }),
      }));
    } catch (err) {
      if (Date.now() - this.lastErrorAt > 60_000) {
        this.lastErrorAt = Date.now();
        this.log.warn(`VictoriaMetrics недоступна (${this.url}): ${(err as Error).message}`);
      }
      return null;
    }
  }
}
