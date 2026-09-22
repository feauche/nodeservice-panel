import {
  AUDIT_PAGE_SIZE_DEFAULT,
  AUDIT_PAGE_SIZE_MAX,
  type AuditEntry,
  type AuditListResponse,
  auditActionLabel,
  auditListQuerySchema,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

/**
 * Мок Журнала: детерминированный набор записей в памяти, фильтры и пагинация как на сервере
 * (упрощённо: поиск — подстрока по действию/актору/логину). Используется в тестах и при VITE_MOCK=1.
 */
export const mockAudit: { entries: AuditEntry[]; authenticated: () => boolean } = {
  entries: [],
  authenticated: () => true,
};

const BASE_TIME = Date.UTC(2026, 7, 29, 18, 0, 0);

const TEMPLATES: Array<Partial<AuditEntry> & { action: string }> = [
  {
    action: 'auth.login.success',
    category: 'auth',
    actorType: 'admin',
    actorDisplay: 'admin',
    metadata: { login: 'admin', amr: ['pwd', 'totp'] },
  },
  {
    action: 'auth.login.failed',
    category: 'auth',
    actorType: 'anonymous',
    actorDisplay: 'root',
    result: 'failed',
    severity: 'warn',
    metadata: { login: 'root', reason: 'credentials' },
  },
  {
    action: 'settings.appearance.updated',
    category: 'settings',
    actorType: 'admin',
    actorDisplay: 'admin',
    targetType: 'settings',
    targetId: 'appearance',
    targetDisplay: 'Внешний вид',
    durationMs: 14,
    changes: { brandName: { before: 'Node[#accent]Service', after: 'Lumax[#accent]VPN' } },
  },
  {
    action: 'system.started',
    category: 'system',
    actorType: 'system',
    actorDisplay: 'NodeService',
    source: 'auto',
    metadata: { version: '0.1.0' },
  },
  {
    action: 'auth.login.throttled',
    category: 'auth',
    actorType: 'anonymous',
    actorDisplay: 'admin',
    result: 'denied',
    severity: 'warn',
    metadata: { login: 'admin' },
  },
  { action: 'auth.logout', category: 'auth', actorType: 'admin', actorDisplay: 'admin' },
];

export function seedAudit(count = 57): void {
  mockAudit.entries = Array.from({ length: count }, (_, i) => {
    const t = TEMPLATES[i % TEMPLATES.length] as (typeof TEMPLATES)[number];
    const seq = count - i;
    return {
      id: `0192b6e0-4c1e-7c3a-9c2d-${String(seq).padStart(12, '0')}`,
      seq,
      occurredAt: new Date(BASE_TIME - i * 90_000).toISOString(),
      actorType: t.actorType ?? 'admin',
      actorId: t.actorType === 'admin' ? 'u1' : null,
      actorDisplay: t.actorDisplay ?? 'admin',
      action: t.action,
      category: t.category ?? 'auth',
      targetType: t.targetType ?? null,
      targetId: t.targetId ?? null,
      targetDisplay: t.targetDisplay ?? null,
      result: t.result ?? 'ok',
      severity: t.severity ?? 'info',
      source: t.source ?? 'manual',
      ip: t.actorType === 'system' ? null : '203.0.113.7',
      userAgent: t.actorType === 'system' ? null : 'Mozilla/5.0 (Macintosh) Chrome/140',
      requestId: `req-${seq}`,
      durationMs: t.durationMs ?? null,
      changes: t.changes ?? null,
      metadata: t.metadata ?? {},
    };
  });
}

/** События конкретного сервера — для тестов вкладки «Журнал» на детальной странице. */
export function seedServerAudit(serverId: string, serverName = 'de-fra-01'): void {
  const actions = ['server.ssh.checked', 'server.agent.install', 'server.updated'];
  for (const [i, action] of actions.entries())
    pushAuditEntry({
      action,
      category: 'server',
      targetType: 'server',
      targetId: serverId,
      targetDisplay: serverName,
      occurredAt: new Date(BASE_TIME + (i + 1) * 60_000).toISOString(),
    });
}

/** Добавить запись «сверху» (имитация live-события). */
export function pushAuditEntry(patch: Partial<AuditEntry> = {}): AuditEntry {
  const top = mockAudit.entries[0];
  const seq = (top?.seq ?? 0) + 1;
  const entry: AuditEntry = {
    id: `0192b6e0-4c1e-7c3a-9c2d-${String(seq).padStart(12, '0')}`,
    seq,
    occurredAt: new Date().toISOString(),
    actorType: 'admin',
    actorId: 'u1',
    actorDisplay: 'admin',
    action: 'auth.unlock',
    category: 'auth',
    targetType: null,
    targetId: null,
    targetDisplay: null,
    result: 'ok',
    severity: 'info',
    source: 'manual',
    ip: '203.0.113.7',
    userAgent: 'test',
    requestId: `req-${seq}`,
    durationMs: null,
    changes: null,
    metadata: {},
    ...patch,
  };
  mockAudit.entries.unshift(entry);
  return entry;
}

function applyFilters(url: URL): { items: AuditEntry[]; error?: string } {
  const raw = Object.fromEntries(url.searchParams.entries());
  const parsed = auditListQuerySchema.safeParse(raw);
  if (!parsed.success) return { items: [], error: parsed.error.issues[0]?.message ?? 'bad query' };
  const f = parsed.data;
  const q = f.q?.toLowerCase();
  const items = mockAudit.entries.filter((e) => {
    if (f.category && !f.category.includes(e.category)) return false;
    if (f.result && !f.result.includes(e.result)) return false;
    if (f.source && e.source !== f.source) return false;
    if (f.actorType && e.actorType !== f.actorType) return false;
    if (f.targetId && e.targetId !== f.targetId) return false;
    if (f.from && e.occurredAt < f.from) return false;
    if (f.to && e.occurredAt > f.to) return false;
    if (q) {
      const hay = [
        e.action,
        auditActionLabel(e.action),
        e.actorDisplay,
        String(e.metadata.login ?? ''),
        e.ip ?? '',
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return { items };
}

export const auditHandlers = [
  http.get('/api/audit', ({ request }) => {
    if (!mockAudit.authenticated())
      return HttpResponse.json(
        {
          type: 'https://nodeservice.dev/problems/auth/unauthenticated',
          title: 'Требуется вход',
          status: 401,
        },
        { status: 401, headers: { 'content-type': 'application/problem+json' } },
      );
    const url = new URL(request.url);
    const { items, error } = applyFilters(url);
    if (error) return HttpResponse.json({ type: 'about:blank', title: error, status: 400 }, { status: 400 });
    const pageSize = Math.min(
      AUDIT_PAGE_SIZE_MAX,
      Number(url.searchParams.get('pageSize') ?? AUDIT_PAGE_SIZE_DEFAULT),
    );
    const totalPages = Math.max(0, Math.ceil(items.length / pageSize));
    const requested = Number(url.searchParams.get('page') ?? 1);
    const page = totalPages === 0 ? 1 : Math.min(requested, totalPages);
    const body: AuditListResponse = {
      items: items.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: items.length,
      totalPages,
    };
    return HttpResponse.json(body);
  }),
  http.get('/api/audit/export', ({ request }) => {
    const url = new URL(request.url);
    const { items } = applyFilters(url);
    const format = url.searchParams.get('format') ?? 'csv';
    if (format === 'json') return HttpResponse.json(items);
    const text = `﻿Время,Действие\r\n${items.map((e) => `${e.occurredAt},${auditActionLabel(e.action)}`).join('\r\n')}\r\n`;
    return new HttpResponse(text, { headers: { 'content-type': 'text/csv; charset=utf-8' } });
  }),
];
