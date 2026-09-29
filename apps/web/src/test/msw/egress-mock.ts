import type { EgressReportDto } from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

/** «Куда сервер может выйти»: по «Проверить» — картина «Казахстан - 1» (Россия и панель закрыты). */
export const mockEgress = new Map<string, EgressReportDto>();

export const kzReport = (): EgressReportDto => ({
  checkedAt: new Date().toISOString(),
  via: 'Германия-1',
  verdict: 'ru_and_panel_cut',
  headline: 'Агент установлен, но сеть сервера не пропускает трафик к панели и в Россию.',
  advice: 'Повторная установка не поможет — напишите хостеру или смените IP.',
  panelPing: true,
  results: [
    { label: 'Панель NodeService', group: 'panel', open: false, ms: null },
    { label: 'ya.ru', group: 'ru', open: false, ms: null },
    { label: 'vk.com', group: 'ru', open: false, ms: null },
    { label: 'google.com', group: 'foreign', open: true, ms: 14 },
    { label: 'github.com', group: 'foreign', open: true, ms: 31 },
    { label: '1.1.1.1', group: 'foreign', open: true, ms: 3 },
  ],
  hosterText: 'Здравствуйте.\nС сервера 206.223.246.150 не устанавливаются TCP-подключения к части адресов.',
});

export function resetEgress(): void {
  mockEgress.clear();
}

export const egressHandlers = [
  http.get('/api/servers/:id/egress', ({ params }) =>
    HttpResponse.json({ report: mockEgress.get(String(params.id)) ?? null }),
  ),
  http.post('/api/servers/:id/egress', async ({ params }) => {
    await new Promise((r) => setTimeout(r, 200));
    const report = kzReport();
    mockEgress.set(String(params.id), report);
    return HttpResponse.json({ report });
  }),
];
