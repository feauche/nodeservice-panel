import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockServers } from '@/test/msw/servers-mock';
import { renderPage } from '@/test/render';
import { DetailText } from './detail-text';

const TEXT = [
  'Онлайн: 476 → 0 (−100 %) за 5 минут',
  '',
  'Из России:',
  '• de-fra-01 — порт не отвечает совсем',
  '• Чужой узел — порт не отвечает совсем',
].join('\n');

describe('DetailText', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    const first = mockServers.items[0];
    if (first) first.country = { ...first.country, code: 'DE' };
  });

  it('флаг — перед сервером парка со страной; остальные строки как есть', async () => {
    const { container } = renderPage(
      () => (
        <p className="whitespace-pre-line">
          <DetailText text={TEXT} />
        </p>
      ),
      '/',
    );
    await screen.findByText(/de-fra-01/);
    const flag = () => container.querySelectorAll('[data-code], [data-testid^="country-flag"]');
    await waitFor(() => expect(flag()).toHaveLength(1));
    expect(container.textContent).toContain('• de-fra-01 — порт не отвечает совсем');
    expect(container.textContent).toContain('• Чужой узел — порт не отвечает совсем');
  });
});
