import type { RemnawaveNode } from '@nodeservice/shared';
import { screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { WaveGroups, waveGroups } from './wave-groups';

const n = (
  uuid: string,
  name: string,
  providerUuid: string | null,
  providerName: string | null,
  cc: string | null,
) =>
  ({
    uuid,
    name,
    address: '10.0.0.1',
    countryCode: cc,
    providerUuid,
    providerName,
    isConnected: true,
    isDisabled: false,
    isConnecting: false,
    lastStatusMessage: null,
    usersOnline: 1,
    trafficUsedBytes: null,
    trafficLimitBytes: null,
  }) as RemnawaveNode;
const NODES = [
  n('1', 'Нидерланды - 1', 'aeza', 'Aeza', 'NL'),
  n('2', 'Германия - 2 (hy2)', 'aeza', 'Aeza', 'DE'),
  n('3', 'Польша - 2 (hy2)', 'aeza', 'Aeza', 'PL'),
  n('4', 'Россия - 1', null, null, 'RU'),
  n('5', 'Россия - 2', null, null, 'RU'),
  n('6', 'Казахстан - 1', 'pskz', 'PS.kz', 'KZ'),
  n('7', 'Без всего', null, null, null),
];

beforeEach(() => {
  resetMockState({ authenticated: true });
  server.use(
    http.get('*/api/nodes/status', () =>
      HttpResponse.json({
        connected: true,
        domain: 'panel.example',
        checkedAt: null,
        error: null,
        stats: null,
        nodes: NODES,
        cert: null,
      }),
    ),
  );
});

describe('волна: как сгруппированы ноды', () => {
  it('провайдер, без провайдера — страна, без обоих — отдельно; большие группы первыми', () => {
    const { groups, loose } = waveGroups(NODES);
    expect(groups.map((g) => `${g.label}:${g.nodes.length}`)).toEqual(['Aeza:3', 'Россия:2', 'PS.kz:1']);
    expect(loose.map((x) => x.name)).toEqual(['Без всего']);
  });

  it('в карточке: что такое волна, группы, одиночки, пример на ваших нодах', async () => {
    renderPage(() => <WaveGroups minNodes={2} windowMinutes={10} />, '/settings/monitoring');
    const list = await screen.findByRole('list', { name: 'Группы нод' });
    expect(list).toHaveTextContent('Aeza3 ноды');
    expect(list).toHaveTextContent('Россия2 ноды без провайдера');
    expect(list).toHaveTextContent('Без провайдера и страны: 1');
    expect(screen.getByText(/Волна — когда за короткое время падают сразу несколько нод/)).toBeVisible();
    expect(screen.getByText(/в волну они не попадут/)).toHaveTextContent('PS.kz — меньше нод');
    expect(screen.getByText(/Пример:/).closest('p')).toHaveTextContent(
      'за 10 мин упали «Нидерланды - 1» и «Германия - 2 (hy2)» (обе Aeza). Будет одна волна «Aeza: 2 из 3»',
    );
  });
});
