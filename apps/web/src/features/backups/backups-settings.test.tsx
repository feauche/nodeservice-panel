import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockBackups } from '@/test/msw/backups-mock';
import { resetMockState } from '@/test/msw/handlers';
import { renderPage } from '@/test/render';
import { BackupsPage } from './backups-page';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

describe('настройки копий: свой чат', () => {
  beforeEach(() => {
    // В моке свой чат уже сохранён — сервер отдаёт его маской, без токена.
    resetMockState({ authenticated: true });
  });

  it('свой чат сохранён — остальные настройки сохраняются: неизменённое поле на сервер не уходит', async () => {
    renderPage(BackupsPage, '/settings/backups');
    const user = userEvent.setup();
    expect(await screen.findByLabelText('Свой чат для копий')).toHaveValue('tgram://***/-1002233445566:12');
    const keep = screen.getByLabelText('Хранить последних');
    await user.clear(keep);
    await user.type(keep, '10');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockBackups.settings.keep).toBe(10));
    // Маску сохранить нельзя (в ней нет токена) — интерфейс её и не отправляет.
    expect(mockBackups.lastUpdate?.telegram).toMatchObject({ enabled: true, target: 'own' });
    expect(mockBackups.lastUpdate?.telegram).not.toHaveProperty('ownUrl');
    expect(mockBackups.settings.telegram.ownUrl).toBe('tgram://***/-1002233445566:12');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled());
  });

  it('новый чат уходит строкой и возвращается маской; пустое поле при другом способе отправки убирает чат', async () => {
    renderPage(BackupsPage, '/settings/backups');
    const user = userEvent.setup();
    const own = await screen.findByLabelText('Свой чат для копий');
    await user.clear(own);
    await user.type(own, `tgram://${TOKEN}/-1009876543210`);
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockBackups.settings.telegram.ownUrl).toBe('tgram://***/-1009876543210'));
    expect(mockBackups.lastUpdate?.telegram?.ownUrl).toBe(`tgram://${TOKEN}/-1009876543210`);
    await waitFor(() => expect(own).toHaveValue('tgram://***/-1009876543210'));

    // Маску с другим номером чата сервер не примет: токена в ней нет — причина видна у кнопки «Сохранить».
    await user.clear(own);
    await user.type(own, 'tgram://***/-100111');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText(/Свой чат — строкой вида/)).toBeInTheDocument();
    expect(mockBackups.settings.telegram.ownUrl).toBe('tgram://***/-1009876543210');
  });

  it('сохраняет вторую копию в S3, но не возвращает ключи в форму', async () => {
    renderPage(BackupsPage, '/settings/backups');
    const user = userEvent.setup();

    await user.click(await screen.findByLabelText('Хранить вторую копию'));
    await user.type(screen.getByLabelText('Endpoint'), 'https://s3.example.com');
    await user.type(screen.getByLabelText('Bucket'), 'nodeservice-safe');
    await user.type(screen.getByLabelText('Access key'), 'AKIA_TEST');
    await user.type(screen.getByLabelText('Secret key'), 'secret-test');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(mockBackups.settings.offsite.enabled).toBe(true));
    expect(mockBackups.lastUpdate?.offsite).toMatchObject({
      endpoint: 'https://s3.example.com',
      region: 'auto',
      bucket: 'nodeservice-safe',
      prefix: 'nodeservice',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret-test',
    });
    await waitFor(() => expect(screen.getByLabelText('Access key')).toHaveValue(''));
    expect(screen.getByLabelText('Access key')).toHaveAttribute(
      'placeholder',
      expect.stringContaining('сохранён'),
    );
  });
});
