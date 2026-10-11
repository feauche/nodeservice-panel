import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { ProviderEdit } from './remna-providers-page';

const uuid = '0cc5a547-c445-4b59-b50d-6b7224513049';
describe('provider editing', () => {
  it('Enter saves the changed name without overwriting a URL changed remotely', async () => {
    resetMockState({ authenticated: true });
    let provider = { uuid, name: 'Old name', loginUrl: 'https://old.example/', faviconLink: null, nodes: [] };
    let saved: unknown;
    server.use(
      http.get('/api/nodes/providers', () => HttpResponse.json({ providers: [provider] })),
      http.patch('/api/nodes/providers/:uuid', async ({ request }) => {
        saved = await request.json();
        provider = { ...provider, ...(saved as object) };
        return HttpResponse.json({ saved: true });
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ProviderEdit uuid={uuid} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Название провайдера');
    await user.clear(name);
    await user.type(name, 'New name');
    provider = { ...provider, loginUrl: 'https://changed-in-remna.example/' };
    await client.invalidateQueries({ queryKey: ['remna-providers'] });
    await waitFor(() =>
      expect(screen.getByLabelText('Ссылка провайдера')).toHaveValue('https://changed-in-remna.example/'),
    );
    await user.click(name);
    await user.keyboard('{Enter}');
    await screen.findByText('Сохранено в Remnawave');
    expect(saved).toEqual({ name: 'New name' });
    expect(provider.loginUrl).toBe('https://changed-in-remna.example/');
    expect(name).toHaveValue('New name');
  });
});
