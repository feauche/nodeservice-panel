import { useBlocker } from '@tanstack/react-router';
import { useCallback } from 'react';

import { ConfirmDialog } from '@/components/confirm-dialog';

/** Одинаковая защита черновиков от ссылок, Back/Forward и закрытия вкладки. */
export function UnsavedChangesGuard({ dirty }: { dirty: boolean }) {
  // Поисковые параметры переключают подразделы одной и той же формы. Её React-состояние при этом
  // сохраняется, поэтому блокируем только настоящий уход на другой экран.
  const shouldBlockFn = useCallback(
    ({ current, next }: { current: { pathname: string }; next: { pathname: string } }) =>
      dirty && current.pathname !== next.pathname,
    [dirty],
  );
  const blocker = useBlocker({
    shouldBlockFn,
    enableBeforeUnload: dirty,
    disabled: !dirty,
    withResolver: true,
  });

  return (
    <ConfirmDialog
      open={blocker.status === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.status === 'blocked') blocker.reset();
      }}
      kind="crit"
      title="Уйти без сохранения?"
      description="Введённые изменения пропадут."
      yesLabel="Да, уйти"
      noLabel="Нет, остаться"
      onConfirm={() => {
        if (blocker.status === 'blocked') blocker.proceed();
      }}
    />
  );
}
