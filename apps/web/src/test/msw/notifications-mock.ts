import {
  createNotificationRequestSchema,
  type Notification,
  type NotificationSeverity,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';
import { mockIncidents } from './incidents-mock';

const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

export const mockNotifications: { items: Notification[] } = { items: [] };

let seq = 0;
const uid = () => {
  seq += 1;
  return `0192e000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};
const make = (
  min: number,
  severity: NotificationSeverity,
  title: string,
  body: string | null,
  link: Notification['link'] = null,
  read = false,
): Notification => ({
  id: uid(),
  severity,
  title,
  body,
  link,
  createdAt: iso(min),
  readAt: read ? iso(min) : null,
});

export function seedNotifications(): void {
  seq = 0;
  const cpu = mockIncidents.items.find((i) => i.kind === 'cpu_high');
  const disk = mockIncidents.items.find((i) => i.kind === 'disk_high');
  mockNotifications.items = [
    make(
      5,
      'warn',
      'Высокая нагрузка на CPU · de-fra-01: ждёт подтверждения',
      'CPU держится на 96% дольше 5 мин (порог 90%). Предложено: Перезапустить контейнер ноды (T2), первый шаг цепочки. Подтвердите запуск в инциденте.',
      cpu ? { to: `/incidents?open=${cpu.id}`, label: 'Открыть инцидент' } : null,
    ),
    make(
      176,
      'ok',
      'Диск заполняется · de-fra-01: «Освободить диск» помогло',
      'Автоматически · диск 71 % < 80 %',
      disk ? { to: `/incidents?open=${disk.id}`, label: 'Открыть инцидент' } : null,
    ),
    make(200, 'info', 'Провайдер «4VPS» добавлен, иконку подтянем в фоне', null),
    make(
      260,
      'warn',
      'Провайдер «Rawi»: иконку не нашли',
      'сайт перенаправляет по кругу — похоже, защита от ботов',
      { to: '/servers/providers', label: 'Открыть провайдеров' },
    ),
    make(
      900,
      'info',
      'Обслуживание: nl-ams-02',
      'обновлений безопасности: 3 · требуется перезагрузка',
      { to: '/servers', label: 'Открыть сервер' },
      true,
    ),
    make(1500, 'ok', 'Агент вышел на связь · nl-ams-02', null, null, true),
  ];
}
seedNotifications();

const response = () => ({
  items: mockNotifications.items,
  unread: mockNotifications.items.filter((n) => !n.readAt).length,
  total: mockNotifications.items.length,
});

export const notificationsHandlers = [
  http.get('/api/notifications', () => HttpResponse.json(response())),
  http.post('/api/notifications', async ({ request }) => {
    const parsed = createNotificationRequestSchema.safeParse(await request.json());
    if (!parsed.success) return HttpResponse.json({ status: 400, detail: 'Проверьте поля' }, { status: 400 });
    const n = make(
      0,
      parsed.data.severity,
      parsed.data.title,
      parsed.data.body ?? null,
      parsed.data.link ?? null,
    );
    mockNotifications.items.unshift(n);
    return HttpResponse.json(n, { status: 201 });
  }),
  http.post('/api/notifications/read-all', () => {
    for (const n of mockNotifications.items) n.readAt ??= iso(0);
    return HttpResponse.json({ unread: 0 });
  }),
  http.delete('/api/notifications/:id', ({ params }) => {
    const i = mockNotifications.items.findIndex((n) => n.id === params.id);
    if (i < 0) return HttpResponse.json({ status: 404, detail: 'Уведомление уже удалено.' }, { status: 404 });
    mockNotifications.items.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.delete('/api/notifications', () => {
    mockNotifications.items = [];
    return new HttpResponse(null, { status: 204 });
  }),
];
