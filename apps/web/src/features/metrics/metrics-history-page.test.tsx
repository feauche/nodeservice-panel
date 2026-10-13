import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { MetricsHistoryPage } from './metrics-history-page';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const names = ['Первая нода', 'Вторая нода'];
let requests: URL[];
let eventCount = 1;
/** Запросы основного графика (навигатор по всему периоду запрашивает историю отдельно и реже). */
const viewRequests = () => requests.filter((u) => u.searchParams.get('maxPoints') === '480');
function lastRequest() {
  const url = viewRequests().at(-1);
  if (!url) throw new Error('Запрос истории не выполнен');
  return url;
}
function param(url: URL, key: string) {
  const value = url.searchParams.get(key);
  if (value === null) throw new Error(`Нет параметра ${key}`);
  return value;
}
const values = (online: number | null) => ({ online, cpu: null, ram: null, load: null, rx: null, tx: null });
beforeEach(() => {
  resetMockState({ authenticated: true });
  requests = [];
  eventCount = 1;
  server.use(
    http.get('*/api/nodes/status', () =>
      HttpResponse.json({
        connected: true,
        domain: 'panel.test',
        checkedAt: null,
        error: null,
        stats: null,
        cert: null,
        nodes: ids.map((uuid, i) => ({
          uuid,
          name: names[i],
          address: `8.8.8.${i + 1}`,
          countryCode: null,
          isConnected: true,
          isDisabled: false,
          isConnecting: false,
          lastStatusMessage: null,
          usersOnline: 10,
          trafficUsedBytes: null,
          trafficLimitBytes: null,
        })),
      }),
    ),
    http.get('*/api/nodes/metrics/history', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const from = Date.parse(param(url, 'from'));
      const to = Date.parse(param(url, 'to'));
      const selected = url.searchParams.get('nodes');
      const nodeIds = selected ? selected.split(',') : ids;
      return HttpResponse.json({
        panel: 'panel.test',
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        bucketSeconds: 300,
        collectedSince: null,
        eventsTruncated: false,
        onlineSummary: {
          peak: 35,
          peakAt: new Date(from + 60000).toISOString(),
          average: 22,
          minimum: 0,
          samples: 2,
          partial: false,
        },
        nodes: nodeIds.map((uuid) => ({
          uuid,
          name: names[ids.indexOf(uuid)],
          address: '8.8.8.8',
          points: [10, 20, null, 30, 40].map((n, i) => ({
            t: from + ((to - from) * (i + 1)) / 6,
            ...values(n),
            min: values(n),
            max: values(n),
          })),
        })),
        events: Array.from({ length: eventCount }, (_, i) => ({
          id: `event${i + 1}`,
          t: (from + to) / 2 - i * 60000,
          nodeUuid: ids[0],
          nodeName: names[0],
          type: 'tcp_check',
          title: 'Проверка TCP: результат неполный',
          summary: 'Недостаточно точек проверки; доступность не подтверждена.',
          link: 'https://check-host.net/check-report/example',
        })),
      });
    }),
  );
});

describe('Метрики', () => {
  it('листает 10/25/50 событий видимого окна', async () => {
    eventCount = 51;
    const user = userEvent.setup();
    renderPage(MetricsHistoryPage, '/metrics');
    const region = await screen.findByRole('region', { name: 'События метрик' });
    await within(region).findByText('1–10 из 51');
    await user.click(within(region).getByRole('button', { name: 'Следующая страница событий' }));
    expect(within(region).getByText('11–20 из 51')).toBeVisible();
    await user.click(within(region).getByRole('combobox', { name: 'Событий на странице' }));
    await user.click(screen.getByRole('option', { name: '25' }));
    expect(within(region).getByText('1–25 из 51')).toBeVisible();
    await user.click(within(region).getByRole('combobox', { name: 'Событий на странице' }));
    await user.click(screen.getByRole('option', { name: '50' }));
    expect(within(region).getByText('1–50 из 51')).toBeVisible();
  });
  it('приближает окно вдвое и возвращает исходный период', async () => {
    renderPage(MetricsHistoryPage, '/metrics');
    await screen.findByText('Проверка TCP: результат неполный');
    const summary = screen.getByTestId('online-period-summary');
    expect(within(summary).getByText('35')).toBeInTheDocument();
    expect(within(summary).getByText('Минимальный онлайн')).toBeInTheDocument();
    const initial = lastRequest();
    const span = Date.parse(param(initial, 'to')) - Date.parse(param(initial, 'from'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Увеличить масштаб' }));
    await waitFor(() => expect(viewRequests()).toHaveLength(2));
    const zoom = lastRequest();
    expect(Date.parse(param(zoom, 'to')) - Date.parse(param(zoom, 'from'))).toBe(span / 2);
    expect(Date.parse(param(zoom, 'from'))).toBeGreaterThan(Date.parse(param(initial, 'from')));
    await user.click(screen.getByRole('button', { name: 'Сбросить масштаб' }));
    await waitFor(() => expect(screen.getByText('Проверка TCP: результат неполный')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Обновить/ }));
    await waitFor(() =>
      expect(lastRequest().searchParams.get('from')).toBe(initial.searchParams.get('from')),
    );
  });
  it('ноды включаются в легенде; «Весь парк» показывает сумму вместо линий', async () => {
    const { container } = renderPage(MetricsHistoryPage, '/metrics');
    await screen.findByText('Проверка TCP: результат неполный');
    const legend = screen.getByRole('table', { name: 'Ноды на графике' });
    // По умолчанию — пять нод с наибольшим онлайном: здесь их две.
    await waitFor(() => expect(within(legend).getAllByRole('checkbox', { checked: true })).toHaveLength(2));
    await waitFor(() => expect(container.querySelectorAll('.recharts-line')).toHaveLength(2));
    const user = userEvent.setup();
    await user.click(within(legend).getByRole('checkbox', { name: 'Вторая нода на графике' }));
    await waitFor(() => expect(container.querySelectorAll('.recharts-line')).toHaveLength(1));
    // Запрос один и тот же: выбор нод не перезапрашивает историю.
    expect(viewRequests()).toHaveLength(1);
    await user.click(screen.getByRole('radio', { name: 'Весь парк' }));
    await waitFor(() => expect(container.querySelectorAll('.recharts-line')).toHaveLength(0));
    expect(container.querySelector('.recharts-area')).not.toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Все 2' }));
    await waitFor(() => expect(container.querySelectorAll('.recharts-line')).toHaveLength(2));
  });
  it('не запрашивает неверные даты и отправляет подтверждённые локальные даты как ISO-инстанты', async () => {
    renderPage(MetricsHistoryPage, '/metrics');
    await screen.findByText('Проверка TCP: результат неполный');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Выбрать даты' }));
    const dialog = await screen.findByRole('dialog');
    const from = within(dialog).getByLabelText('Начало периода');
    const to = within(dialog).getByLabelText('Конец периода');
    fireEvent.change(from, { target: { value: '2026-10-12T08:00' } });
    fireEvent.change(to, { target: { value: '2026-10-11T08:00' } });
    await user.click(within(dialog).getByRole('button', { name: 'Показать историю' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Выберите начало раньше конца');
    expect(viewRequests()).toHaveLength(1);
    fireEvent.change(from, { target: { value: '2026-10-11T08:00' } });
    fireEvent.change(to, { target: { value: '2026-10-12T08:00' } });
    await user.click(within(dialog).getByRole('button', { name: 'Показать историю' }));
    await waitFor(() => expect(viewRequests()).toHaveLength(2));
    expect(lastRequest().searchParams.get('from')).toBe(new Date('2026-10-11T08:00').toISOString());
    expect(lastRequest().searchParams.get('to')).toBe(new Date('2026-10-12T08:00').toISOString());
  });
  it('сохраняет разрыв неизвестных замеров и открывает подробности события', async () => {
    const { container } = renderPage(MetricsHistoryPage, '/metrics');
    const title = await screen.findByText('Проверка TCP: результат неполный');
    await waitFor(() => {
      const path = container.querySelector('.recharts-line-curve');
      expect(path).not.toBeNull();
      expect(path?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
    });
    await userEvent.setup().click(title);
    expect(screen.getByText(/Недостаточно точек проверки; доступность не подтверждена/)).toBeVisible();
    expect(screen.getAllByRole('link', { name: 'Подробнее' })[0]).toHaveAttribute(
      'href',
      'https://check-host.net/check-report/example',
    );
    await waitFor(() => expect(viewRequests()).toHaveLength(2));
    const url = lastRequest();
    expect(Date.parse(param(url, 'to')) - Date.parse(param(url, 'from'))).toBe(30 * 60000);
  });
});
