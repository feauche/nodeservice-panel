import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { sampleReach } from '@/test/msw/reach-sample';
import { ReachabilityCard } from './reachability-card';

describe('ReachabilityCard (B1)', () => {
  it('матрица «кто проверял × порт», вывод по портам и оговорка', () => {
    render(<ReachabilityCard result={sampleReach('de-1', 'closed443')} />);
    const card = screen.getByTestId('reachability-card');
    expect(within(card).getByText(/Доступность de-1 снаружи/)).toBeInTheDocument();
    expect(within(card).getByText(/с 3 независимых серверов парка/)).toBeInTheDocument();
    for (const name of ['nl-ams-02', 'fi-hel-01', 'pl-waw-03'])
      expect(within(within(card).getByRole('table')).getByRole('rowheader', { name })).toBeInTheDocument();
    expect(within(within(card).getByRole('table')).getAllByText('открыт · 12 мс')).toHaveLength(3);
    expect(within(within(card).getByRole('table')).getAllByText('закрыт')).toHaveLength(3);
    expect(within(card).getByText('22: открыт со всех')).toBeInTheDocument();
    expect(within(card).getByText('443: закрыт со всех')).toBeInTheDocument();
    expect(within(card).getByText(/а не из сети пользователей/)).toBeInTheDocument();
  });

  it('частично: «открыт с 2 из 3»', () => {
    render(<ReachabilityCard result={sampleReach('de-1', 'partial')} />);
    expect(screen.getByText('443: открыт с 2 из 3')).toBeInTheDocument();
  });

  it('не ответивший проверяющий показан строкой с причиной и не считается в шапке', () => {
    const r = sampleReach('de-1', 'open');
    r.probes[1] = {
      from: 'fi-hel-01',
      ok: false,
      error: 'Не удалось подключиться к проверяющему серверу.',
      ports: [],
      dns: null,
    };
    render(<ReachabilityCard result={r} />);
    expect(
      within(screen.getByRole('table')).getByText(/Не ответил: Не удалось подключиться/),
    ).toBeInTheDocument();
    expect(screen.getByText(/с 2 независимых серверов парка/)).toBeInTheDocument();
  });

  it('расхождение DNS подсвечивается', () => {
    const r = sampleReach('de-1', 'open');
    r.dns = { answers: ['1.1.1.1', '2.2.2.2'], consistent: false };
    r.probes[0] = { ...(r.probes[0] as (typeof r.probes)[number]), dns: '2.2.2.2' };
    render(<ReachabilityCard result={r} />);
    expect(within(screen.getByRole('table')).getByText('2.2.2.2')).toHaveClass('text-warn');
  });
});
