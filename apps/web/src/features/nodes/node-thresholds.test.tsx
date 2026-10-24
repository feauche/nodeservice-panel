import type { RemnawaveNode } from '@nodeservice/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { mockRemnawave } from '@/test/msw/remnawave-mock';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { NodeDialog } from './node-dialog';

const NODE = {
  uuid: '11111111-1111-4111-8111-111111111111',
  name: 'Германия - 1',
  address: '177.3.216.253',
  port: 443,
  countryCode: 'DE',
  isConnected: true,
  isDisabled: false,
  isConnecting: false,
  usersOnline: 120,
} as RemnawaveNode;

let saved: Record<string, unknown> | null = null;
beforeEach(() => {
  resetMockState({ authenticated: true });
  saved = null;
  Object.assign(mockRemnawave, { connected: true, domain: 'panel.example.com', nodes: [NODE] });
  server.use(
    http.get('*/api/nodes/:uuid/preferences', () =>
      HttpResponse.json({
        whitelist: false,
        channelMbps: 1000,
        note: '',
        loadWarningPerCore: null,
        memoryWarningPercent: null,
        channelWarningPercent: null,
      }),
    ),
    http.put('*/api/nodes/:uuid/preferences', async ({ request }) => {
      saved = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(saved);
    }),
  );
});

describe('Окно ноды: свои пороги нагрузки', () => {
  it('«Канал выше, % лимита» — третье поле рядом с процессором и памятью; пустое — общий порог', async () => {
    const user = userEvent.setup();
    renderPage(() => <NodeDialog node={NODE} stale={false} onClose={vi.fn()} />, '/nodes');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('tab', { name: /Настройки/ }));
    const field = await within(dialog).findByLabelText('Канал выше, % лимита');
    expect(field).toHaveAttribute('placeholder', 'Общий порог · 90');
    expect(dialog).toHaveTextContent('Слежение за каналом сейчас выключено в «Настройки → События».');
    await user.type(field, '95');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(saved).toMatchObject({ channelWarningPercent: 95, channelMbps: 1000 }));
  });
});
