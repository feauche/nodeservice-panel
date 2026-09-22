import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog, type ConfirmKind } from './confirm-dialog';

function Harness({ onConfirm, kind }: { onConfirm: () => void; kind?: ConfirmKind }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        открыть
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        kind={kind}
        title="Перезапустить ноду?"
        description="Клиенты переподключатся."
        note="Причина проблемы не уйдёт."
        yesLabel="Да, перезапустить"
        onConfirm={onConfirm}
      />
    </>
  );
}

describe('ConfirmDialog', () => {
  it('рисует заголовок, текст, приписку и кнопки; фокус на «Да»', async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'открыть' }));
    const dlg = await screen.findByRole('alertdialog', { name: 'Перезапустить ноду?' });
    expect(dlg).toHaveTextContent('Клиенты переподключатся.');
    expect(dlg).toHaveTextContent('Причина проблемы не уйдёт.');
    expect(screen.getByRole('button', { name: 'Нет' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Да, перезапустить' })).toHaveFocus());
  });

  it('для kind=crit фокус на «Нет»', async () => {
    render(<Harness onConfirm={vi.fn()} kind="crit" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'открыть' }));
    await screen.findByRole('alertdialog');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Нет' })).toHaveFocus());
  });

  it('Escape закрывает без подтверждения', async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'открыть' }));
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('«Нет» закрывает без подтверждения', async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'открыть' }));
    await user.click(await screen.findByRole('button', { name: 'Нет' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('«Да» вызывает onConfirm', async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'открыть' }));
    await user.click(await screen.findByRole('button', { name: 'Да, перезапустить' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
