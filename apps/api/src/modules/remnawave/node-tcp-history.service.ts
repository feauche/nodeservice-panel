import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type TcpCheckReport, tcpCheckReportSchema } from '@nodeservice/shared';
import { desc, like } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { AuditService } from '../audit/audit.service.js';
@Injectable()
export class NodeTcpHistoryService {
  constructor(
    @Inject(DB) private db: Db,
    private audit: AuditService,
  ) {}
  async save(uuid: string, name: string, report: TcpCheckReport) {
    const id = randomUUID();
    await this.db
      .insert(appMeta)
      .values({ key: `checkhost.node.${uuid}.${id}`, value: JSON.stringify({ id, report }) });
    await this.audit.record({
      action: 'remnawave.tcp.checked',
      target: { type: 'node', id: uuid, display: name },
      metadata: {
        verdict: report.verdict,
        checkedAt: report.checkedAt,
        ports: (report.ports ?? [report])
          .map((p) => {
            const russia = p.observations.filter((o) => o.country === 'ru'),
              other = p.observations.filter((o) => o.country !== 'ru');
            const verdict = {
              reachable: 'доступен',
              russia_unreachable: 'недоступен из РФ',
              port_unreachable: 'не отвечает',
              unknown: 'неполный результат',
            }[p.verdict];
            return `${p.target}: ${verdict}; РФ ответили ${russia.filter((o) => o.state === 'ok').length}/${russia.length}, другие страны ${other.filter((o) => o.state === 'ok').length}/${other.length}`;
          })
          .join('\n'),
        reports: (report.ports ?? [report]).flatMap((p) => (p.link ? [p.link] : [])),
      },
    });
  }
  async list(uuid: string) {
    const rows = await this.db.query.appMeta.findMany({
      where: like(appMeta.key, `checkhost.node.${uuid}.%`),
      orderBy: desc(appMeta.updatedAt),
      limit: 20,
    });
    return {
      checks: rows.flatMap((row) => {
        try {
          const entry = JSON.parse(row.value);
          const report = tcpCheckReportSchema.parse(entry.report);
          return [{ id: String(entry.id), report }];
        } catch {
          return [];
        }
      }),
    };
  }
}
