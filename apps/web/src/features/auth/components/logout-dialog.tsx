import { useNavigate } from '@tanstack/react-router';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { useLogout } from '../queries';

interface LogoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Единое подтверждение «Выйти из панели?» — для шапки, экрана блокировки и настроек. */
export function LogoutDialog({ open, onOpenChange }: LogoutDialogProps) {
  const logout = useLogout();
  const navigate = useNavigate();

  const doLogout = async () => {
    try {
      await logout.mutateAsync();
    } catch {
      // Сервер недоступен — локально сессия уже сброшена в useLogout, просто уходим.
    }
    await navigate({ to: '/login' });
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      kind="warn"
      title="Выйти из панели?"
      description="Эта сессия завершится, для входа снова понадобятся пароль и код 2FA (или запомненное устройство)."
      yesLabel="Да, выйти"
      noLabel="Нет"
      loading={logout.isPending}
      onConfirm={doLogout}
    />
  );
}
