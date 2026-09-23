import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentMetrics } from '@nodeservice/shared';

import type { Env } from '../../config/env.schema.js';

/**
 * Запись метрик агентов в VictoriaMetrics (import в формате Prometheus exposition).
 * Fire-and-forget: недоступная VM не должна ронять WebSocket-поток — ошибки в лог с антиспамом.
 */
@Injectable()
export class VmWriterService {
  private readonly log = new Logger(VmWriterService.name);
  private readonly url: string;
  private lastErrorAt = 0;

  constructor(config: ConfigService<Env, true>) {
    this.url = config.get('VM_URL');
  }

  async write(serverId: string, serverName: string, m: AgentMetrics): Promise<void> {
    const l = `{server_id="${serverId}",server_name="${serverName.replaceAll('"', '')}"}`;
    const lines = [
      `nodeservice_cpu_pct${l} ${m.cpuPct}`,
      `nodeservice_load1${l} ${m.load1}`,
      `nodeservice_mem_used_mb${l} ${m.memUsedMb}`,
      `nodeservice_mem_total_mb${l} ${m.memTotalMb}`,
      `nodeservice_disk_used_mb${l} ${m.diskUsedMb}`,
      `nodeservice_disk_total_mb${l} ${m.diskTotalMb}`,
      `nodeservice_net_rx_bps${l} ${m.netRxBps}`,
      `nodeservice_net_tx_bps${l} ${m.netTxBps}`,
      `nodeservice_net_rx_pps${l} ${m.netRxPps}`,
      `nodeservice_net_tx_pps${l} ${m.netTxPps}`,
      `nodeservice_uptime_sec${l} ${m.uptimeSec}`,
      ...(m.conntrackCount === null ? [] : [`nodeservice_conntrack_count${l} ${m.conntrackCount}`]),
      // Старый агент поле не шлёт — серии нет, панель не судит о ноде.
      ...(typeof m.xrayRunning === 'boolean'
        ? [`nodeservice_xray_running${l} ${m.xrayRunning ? 1 : 0}`]
        : []),
    ];
    try {
      const res = await fetch(`${this.url}/api/v1/import/prometheus`, {
        method: 'POST',
        body: `${lines.join('\n')}\n`,
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) throw new Error(`VM ответила ${res.status}`);
    } catch (err) {
      // Не чаще раза в минуту, чтобы не заспамить лог при лежащей VM.
      if (Date.now() - this.lastErrorAt > 60_000) {
        this.lastErrorAt = Date.now();
        this.log.warn(`Метрики не записались в VictoriaMetrics (${this.url}): ${(err as Error).message}`);
      }
    }
  }
}
