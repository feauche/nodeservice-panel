import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
export type TcpVerdict = 'reachable' | 'russia_unreachable' | 'port_unreachable' | 'unknown';
export type TcpObservation = {
  node: string;
  country: string;
  city: string;
  state: 'ok' | 'failed' | 'pending';
  error: string | null;
};
export type TcpReport = {
  verdict: TcpVerdict;
  checkedAt: string;
  target: string;
  link: string | null;
  observations: TcpObservation[];
  error: string | null;
  ports?: TcpReport[];
};
export function publicIp(value: string): boolean {
  if (!isIP(value)) return false;
  if (isIP(value) === 6) return /^(2|3)/i.test(value);
  const [a = 0, b = 0] = value.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
export function classifyTcp(rows: TcpObservation[]): TcpVerdict {
  const ru = rows.filter((r) => r.country === 'ru'),
    foreign = rows.filter((r) => r.country !== 'ru');
  // Two Russian vantage points and two foreign countries; missing results are never failures.
  const enough = ru.length >= 2 && new Set(foreign.map((r) => r.country)).size >= 2;
  if (!enough || rows.some((r) => r.state === 'pending')) return 'unknown';
  if (ru.every((r) => r.state === 'failed') && foreign.every((r) => r.state === 'ok'))
    return 'russia_unreachable';
  if (rows.every((r) => r.state === 'failed')) return 'port_unreachable';
  if (ru.every((r) => r.state === 'ok') && foreign.some((r) => r.state === 'ok')) return 'reachable';
  return 'unknown';
}
export function combineTcpReports(reports: TcpReport[]): TcpVerdict {
  if (reports.some((r) => r.verdict === 'reachable')) return 'reachable';
  if (!reports.length || reports.some((r) => r.verdict === 'unknown')) return 'unknown';
  if (reports.every((r) => r.verdict === 'port_unreachable')) return 'port_unreachable';
  return reports.some((r) => r.verdict === 'russia_unreachable') ? 'russia_unreachable' : 'unknown';
}
export function describeTcp(report: TcpReport): string {
  const names: Record<TcpVerdict, string> = {
    reachable: 'доступен из РФ и других стран',
    russia_unreachable: 'недоступен из РФ, доступен из других стран',
    port_unreachable: 'недоступен из РФ и других стран',
    unknown: 'недостаточно данных',
  };
  return (report.ports ?? [report])
    .map(
      (r) => `${r.target}: ${names[r.verdict]}.${r.error ? ` ${r.error}` : ''}${r.link ? `\n${r.link}` : ''}`,
    )
    .join('\n');
}
@Injectable()
export class CheckHostService {
  private catalog: { at: number; nodes: Record<string, { location: string[] }> } | null = null;
  private inflight = new Map<string, Promise<TcpReport>>();
  private active = 0;
  private waiters: Array<() => void> = [];
  async check(ip: string, port: number): Promise<TcpReport> {
    const target = `${isIP(ip) === 6 ? `[${ip}]` : ip}:${port}`;
    const existing = this.inflight.get(target);
    if (existing) return existing;
    const promise = this.run(ip, port, target).finally(() => this.inflight.delete(target));
    this.inflight.set(target, promise);
    return promise;
  }
  async checkNode(ip: string, primaryPort: number, nodePort?: number | null): Promise<TcpReport> {
    const primary = await this.check(ip, primaryPort);
    const reports = [primary];
    const ports = new Set<number>([primaryPort]);
    if (primaryPort === 5492 && ['port_unreachable', 'russia_unreachable'].includes(primary.verdict)) {
      reports.push(await this.check(ip, 22));
      ports.add(22);
    }
    if (nodePort && Number.isInteger(nodePort) && nodePort > 0 && nodePort <= 65535 && !ports.has(nodePort)) {
      reports.push(await this.check(ip, nodePort));
    }
    return {
      ...primary,
      verdict: combineTcpReports(reports),
      checkedAt: new Date().toISOString(),
      ports: reports,
    };
  }
  private async json(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`https://check-host.net${path}`, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Check-Host: HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 1000000) throw new Error('Слишком большой ответ Check-Host');
    return JSON.parse(text);
  }
  private async run(ip: string, port: number, target: string): Promise<TcpReport> {
    const report: TcpReport = {
      verdict: 'unknown',
      checkedAt: new Date().toISOString(),
      target,
      link: null,
      observations: [],
      error: null,
    };
    if (!publicIp(ip) || !Number.isInteger(port) || port < 1 || port > 65535)
      return { ...report, error: 'Нужен публичный IP и корректный TCP-порт.' };
    if (this.active >= 2) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.active++;
    try {
      if (!this.catalog || Date.now() - this.catalog.at > 3600000) {
        const data = await this.json('/nodes/hosts');
        this.catalog = {
          at: Date.now(),
          nodes: (data.nodes ?? {}) as Record<string, { location: string[] }>,
        };
      }
      const entries = Object.entries(this.catalog.nodes).filter(
        ([key, n]) => /^[a-z0-9.-]+\.node\.check-host\.net$/.test(key) && Array.isArray(n.location),
      );
      const ru = entries.filter(([, n]) => n.location[0] === 'ru').slice(0, 3);
      const seen = new Set<string>();
      const foreign = entries
        .filter(([, n]) => {
          const cc = n.location[0] ?? '';
          if (cc === 'ru' || seen.has(cc)) return false;
          seen.add(cc);
          return true;
        })
        .slice(0, 3);
      if (ru.length < 2 || foreign.length < 2)
        throw new Error('Недостаточно точек Check-Host в РФ и других странах.');
      const query = new URLSearchParams({ host: target });
      for (const [key] of [...ru, ...foreign]) query.append('node', key);
      const start = await this.json(`/check-tcp?${query}`);
      if (
        start.ok !== 1 ||
        typeof start.request_id !== 'string' ||
        !/^[a-zA-Z0-9_-]+$/.test(start.request_id)
      )
        throw new Error('Check-Host не запустил проверку.');
      report.link = `https://check-host.net/check-report/${start.request_id}`;
      const nodes = (start.nodes ?? {}) as Record<string, string[]>;
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const result = await this.json(`/check-result/${start.request_id}`);
        report.observations = Object.entries(nodes).map(([key, meta]) => {
          const items = result[key];
          const leg = Array.isArray(items) ? items[0] : null;
          const obj = leg && typeof leg === 'object' ? (leg as Record<string, unknown>) : null;
          const state =
            obj && typeof obj.time === 'number'
              ? 'ok'
              : obj && typeof obj.error === 'string'
                ? 'failed'
                : 'pending';
          return {
            node: key,
            country: meta[0] ?? '',
            city: meta[2] ?? '',
            state,
            error: state === 'failed' ? String(obj?.error).slice(0, 200) : null,
          };
        });
        if (report.observations.length && report.observations.every((r) => r.state !== 'pending')) break;
      }
      report.verdict = classifyTcp(report.observations);
      report.checkedAt = new Date().toISOString();
      return report;
    } catch (error) {
      return { ...report, error: error instanceof Error ? error.message : 'Check-Host недоступен' };
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
