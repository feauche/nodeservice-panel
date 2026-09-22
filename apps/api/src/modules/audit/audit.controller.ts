import { once } from 'node:events';
import { Controller, Get, Header, Headers, type MessageEvent, Query, Req, Res, Sse } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { AUDIT_EXPORT_MAX, AUDIT_SSE_EVENT, type AuditEntry, auditActionLabel } from '@nodeservice/shared';
import type { Request, Response } from 'express';
import { from, interval, merge, Observable } from 'rxjs';
import { map, mergeMap } from 'rxjs/operators';

import { AuditExportQueryDto, AuditListQueryDto, AuditListResponseDto } from './audit.dto.js';
import { AuditEvents } from './audit.events.js';
import { AuditRepository } from './audit.repository.js';

const SSE_PING_MS = 20_000;

const CSV_COLUMNS: Array<[header: string, pick: (e: AuditEntry) => unknown]> = [
  ['Время', (e) => e.occurredAt],
  ['Категория', (e) => e.category],
  ['Действие', (e) => auditActionLabel(e.action)],
  ['Ключ', (e) => e.action],
  ['Результат', (e) => e.result],
  ['Важность', (e) => e.severity],
  ['Источник', (e) => e.source],
  ['Кто', (e) => e.actorDisplay],
  ['Тип актора', (e) => e.actorType],
  ['Цель', (e) => e.targetDisplay ?? ''],
  ['IP', (e) => e.ip ?? ''],
  ['User-Agent', (e) => e.userAgent ?? ''],
  ['Запрос', (e) => e.requestId ?? ''],
  ['Длительность, мс', (e) => e.durationMs ?? ''],
  ['Изменения', (e) => (e.changes ? JSON.stringify(e.changes) : '')],
  ['Данные', (e) => JSON.stringify(e.metadata)],
  ['ID', (e) => e.id],
];

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  // Защита от формул в Excel/Sheets (=, +, -, @) и экранирование кавычек.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r;]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(
    private readonly repo: AuditRepository,
    private readonly events: AuditEvents,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Журнал: страница записей (новые сверху) с фильтрами и поиском' })
  @ApiOkResponse({ type: AuditListResponseDto })
  list(@Query() query: AuditListQueryDto): Promise<AuditListResponseDto> {
    return this.repo.list(query);
  }

  /**
   * Live-лента. Событие `audit` с id=seq; при переподключении браузер шлёт Last-Event-ID —
   * догоняем пропущенное из БД. `ping` каждые 20 с держит соединение через прокси.
   */
  @Sse('stream')
  @Header('X-Accel-Buffering', 'no')
  @ApiOperation({ summary: 'Журнал: SSE-лента новых записей' })
  stream(@Headers('last-event-id') lastEventId?: string): Observable<MessageEvent> {
    const replay$ =
      lastEventId && /^\d{1,15}$/.test(lastEventId)
        ? from(this.repo.since(Number(lastEventId))).pipe(mergeMap((rows) => from(rows)))
        : from([] as AuditEntry[]);
    const live$ = new Observable<AuditEntry>((subscriber) =>
      this.events.onCreated((e) => subscriber.next(e)),
    );
    const entries$ = merge(replay$, live$).pipe(
      map((e): MessageEvent => ({ type: AUDIT_SSE_EVENT, id: String(e.seq), data: e })),
    );
    const ping$ = interval(SSE_PING_MS).pipe(map((): MessageEvent => ({ type: 'ping', data: '' })));
    return merge(entries$, ping$);
  }

  @Get('export')
  @ApiOperation({ summary: `Журнал: выгрузка CSV/JSON по фильтрам (до ${AUDIT_EXPORT_MAX} строк)` })
  @ApiProduces('text/csv', 'application/json')
  async export(
    @Query() query: AuditExportQueryDto,
    @Req() _req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { format, ...filter } = query;
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
    res.status(200);
    res.setHeader(
      'Content-Type',
      format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    );
    res.setHeader('Content-Disposition', `attachment; filename="journal-${stamp}.${format}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();

    // Клиент ушёл (закрыл вкладку) — прекращаем читать БД. Именно res.on('close'): у req 'close'
    // в Node ≥16 срабатывает сразу после чтения тела запроса, а не при обрыве соединения.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const write = async (chunk: string): Promise<void> => {
      if (res.writableEnded || res.destroyed) return;
      if (!res.write(chunk)) await once(res, 'drain').catch(() => undefined);
    };

    if (format === 'csv') {
      // BOM — чтобы Excel открыл кириллицу как UTF-8.
      await write(`\uFEFF${CSV_COLUMNS.map(([h]) => csvCell(h)).join(',')}\r\n`);
      for await (const e of this.repo.iterate(filter, AUDIT_EXPORT_MAX, abort.signal)) {
        await write(`${CSV_COLUMNS.map(([, pick]) => csvCell(pick(e))).join(',')}\r\n`);
      }
    } else {
      await write('[\n');
      let first = true;
      for await (const e of this.repo.iterate(filter, AUDIT_EXPORT_MAX, abort.signal)) {
        await write(`${first ? '' : ',\n'}${JSON.stringify(e)}`);
        first = false;
      }
      await write('\n]\n');
    }
    res.end();
  }
}
