import {
  type BsRental,
  type BsRentalTarget,
  bsRentalChangePreviewSchema,
  bsRentalChangeResultSchema,
  bsRentalCheckSchema,
  bsRentalsSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { NetworkIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useNodes } from '@/features/nodes/nodes-api';
import { formatDate } from '@/features/security/security-format';
import { BarButton, CardButton, Pill, RowButton, SettingsRow } from '@/features/settings/settings-ui';
import { api, apiErrorMessage } from '@/lib/api';
import { explainProbeError } from '@/lib/probe-error';

const stateNames: Record<string, string> = {
  active: 'Активна',
  throttled: 'Ограничена',
  node_down: 'Вход недоступен',
  pending: 'Ожидает запуска',
  suspended: 'Приостановлена',
  expired: 'Срок истёк',
};
export function BsRentals() {
  const q = useQuery({
    queryKey: ['bschecker-rentals'],
    queryFn: ({ signal }) => api.get('/integrations/bschecker/rentals', bsRentalsSchema, signal),
    refetchInterval: (query) => (query.state.data?.rentals.some((r) => !r.config.in_sync) ? 15000 : false),
  });
  const [edit, setEdit] = useState<BsRental | null>(null);
  const [checkTarget, setCheckTarget] = useState<string | null>(null);
  const [checkOpen, setCheckOpen] = useState(false);
  const check = useMutation({
    mutationFn: (id: string) =>
      api.post(`/integrations/bschecker/rentals/${id}/check`, {}, bsRentalCheckSchema),
    onSuccess: () => void q.refetch(),
  });
  const progress = useQuery({
    queryKey: ['bschecker-rental-check', checkTarget, check.data?.id],
    enabled: !!checkTarget && !!check.data && ['pending', 'running'].includes(check.data.status),
    queryFn: ({ signal }) =>
      api.get(
        `/integrations/bschecker/rentals/${checkTarget}/check/${check.data?.id}`,
        bsRentalCheckSchema,
        signal,
      ),
    refetchInterval: (query) =>
      query.state.data && ['done', 'error'].includes(query.state.data.status) ? false : 3000,
  });
  const result = progress.data ?? check.data;
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-border bg-surface">
      <header className="flex flex-none items-start justify-between gap-3 border-b border-border px-[18px] py-4">
        <div>
          <h2 className="font-heading text-[15px] font-semibold">Арендованные точки входа</h2>
          <p className="mt-1 text-[12px] text-text-3">Входы BS Checker → ваши выходные ноды</p>
        </div>
        <BarButton className="h-10 min-w-0" disabled={q.isFetching} onClick={() => void q.refetch()}>
          Обновить
        </BarButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-3 max-lg:max-h-[500px]">
        {q.isPending && <p className="py-4 text-[13px] text-text-3">Загружаю точки…</p>}
        {q.isError && (
          <p role="alert" className="py-4 text-[13px] text-crit">
            {apiErrorMessage(q.error)}
          </p>
        )}
        {q.data?.rentals.length === 0 && (
          <div className="flex items-start gap-3 py-5">
            <NetworkIcon className="size-5 text-brand" />
            <div>
              <p className="text-[13px] font-medium">В аккаунте пока нет арендованных точек</p>
              <p className="mt-1 text-[12px] text-text-3">
                После оформления аренды в BS Checker здесь появятся входы, трафик и настройки выходных
                адресов.
              </p>
            </div>
          </div>
        )}
        <div className="grid gap-3 py-3">
          {q.data?.rentals.map((r) => (
            <div key={r.id} className="rounded-[12px] border border-border bg-surface-2 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="min-w-0 flex-1 text-[14px] font-semibold">{r.label || r.endpoint}</h3>
                <Pill tone={r.status === 'active' ? 'ok' : 'warn'}>{stateNames[r.status] ?? r.status}</Pill>
              </div>
              <p className="mt-1 font-mono text-[12px] text-text-3">
                Вход {r.endpoint} · {r.proto.toUpperCase()}
              </p>
              <div className="my-3 space-y-2 border-y border-border py-3">
                {r.targets.map((t) => (
                  <div
                    key={`${t.host}:${t.port}`}
                    className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]"
                  >
                    <span className="break-all font-mono">
                      → {t.host}:{t.port}
                    </span>
                    <Pill>{t.backup ? 'Резерв' : `Основной · вес ${t.weight}`}</Pill>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 text-[12px]">
                <span className="text-text-3">Трафик</span>
                <span>
                  {r.traffic.used_gb.toFixed(1)} /{' '}
                  {r.traffic.unlimited ? '∞' : `${r.traffic.quota_gb ?? '—'} ГБ`}
                </span>
                <span className="text-text-3">Применение</span>
                <span className={r.config.in_sync ? 'text-ok' : 'text-warn'}>
                  {r.config.in_sync
                    ? 'Применено'
                    : `Ожидает · ${r.config.applied_version} → ${r.config.desired_version}`}
                </span>
                <span className="text-text-3">Срок аренды</span>
                <span>{r.expires_at ? formatDate(r.expires_at) : '—'}</span>
              </div>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <BarButton
                  className="h-10"
                  disabled={!r.can_check || check.isPending}
                  onClick={() => {
                    setCheckTarget(r.id);
                    setCheckOpen(true);
                    check.reset();
                    check.mutate(r.id);
                  }}
                >
                  Проверить с точки входа
                </BarButton>
                <CardButton className="h-10" onClick={() => setEdit(r)}>
                  Изменить выходы
                </CardButton>
              </div>
            </div>
          ))}
        </div>
        <Dialog open={checkOpen} onOpenChange={setCheckOpen}>
          <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-[660px]">
            <DialogTitle className="pr-10">Проверка с точки входа</DialogTitle>
            <DialogDescription>
              Доступность сохранённых выходных адресов из арендованной точки BS Checker.
            </DialogDescription>
            <div className="min-h-0 overflow-y-auto">
              {check.isPending && <p className="py-4 text-text-3">Выполняется проверка…</p>}
              {(check.isError || progress.isError) && (
                <p role="alert" className="py-3 text-crit">
                  {apiErrorMessage(check.error ?? progress.error)}
                </p>
              )}
              {result && (
                <>
                  <Pill tone={result.status === 'done' ? 'ok' : 'warn'}>
                    {result.status === 'done'
                      ? 'Завершена'
                      : ['pending', 'running'].includes(result.status)
                        ? 'Выполняется'
                        : 'Ошибка проверки'}
                  </Pill>
                  {result.results.map((row) => (
                    <div
                      key={`${row.role}-${row.ip}-${row.port}-${row.backup}`}
                      className="mt-3 flex items-center justify-between gap-3 rounded-[10px] border border-border bg-surface-2 p-3"
                    >
                      <div>
                        <p className="font-mono text-[13px]">
                          {row.ip}:{row.port}
                        </p>
                        <p className="mt-1 text-[12px] text-text-3">
                          {row.backup ? 'Резервный выход' : 'Основной выход'}
                          {row.rtt_ms !== null && row.rtt_ms !== undefined ? ` · ${row.rtt_ms} мс` : ''}
                          {row.err ? ` · ${explainProbeError(row.err)}` : ''}
                        </p>
                        {row.err && (
                          <details className="mt-2 text-[12px] text-text-3">
                            <summary className="cursor-pointer text-text-2">Технические детали</summary>
                            <p className="mt-1 break-all font-mono">{row.err}</p>
                          </details>
                        )}
                      </div>
                      <Pill tone={row.ok === null ? 'muted' : row.ok ? 'ok' : 'crit'}>
                        {row.ok === null ? 'Нет результата' : row.ok ? 'Доступен' : 'Не отвечает'}
                      </Pill>
                    </div>
                  ))}
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>
        {edit && (
          <RentalEditor rental={edit} onClose={() => setEdit(null)} onUpdated={() => void q.refetch()} />
        )}
      </div>
    </section>
  );
}
function RentalEditor({
  rental,
  onClose,
  onUpdated,
}: {
  rental: BsRental;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const nodes = useNodes();
  const [targets, setTargets] = useState(rental.targets.map((t) => ({ ...t, rowId: crypto.randomUUID() }))),
    [confirm, setConfirm] = useState(false),
    [error, setError] = useState<string | null>(null);
  const prepare = useMutation({
    mutationFn: () =>
      api.post(
        `/integrations/bschecker/rentals/${rental.id}/changes`,
        { targets: targets.map(({ rowId, ...target }) => target) },
        bsRentalChangePreviewSchema,
      ),
    onSuccess: () => setConfirm(true),
  });
  const apply = useMutation({
    mutationFn: (id: string) =>
      api.post(`/integrations/bschecker/rentals/changes/${id}/execute`, {}, bsRentalChangeResultSchema),
    onSuccess: () => onUpdated(),
  });
  const uncertain = apply.data?.status === 'uncertain' || apply.isError;
  function update(index: number, patch: Partial<BsRentalTarget>) {
    setTargets(targets.map((t, i) => (i === index ? { ...t, ...patch } : t)));
    prepare.reset();
    setError(null);
  }
  async function submit() {
    setError(null);
    try {
      await prepare.mutateAsync();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }
  async function execute() {
    if (!prepare.data) return;
    setConfirm(false);
    try {
      await apply.mutateAsync(prepare.data.id);
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }
  const addresses = (list: BsRentalTarget[]) =>
    list.map((t) => `${t.host}:${t.port} (${t.backup ? 'резерв' : `вес ${t.weight}`})`).join(', ');
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !apply.isPending) onClose();
      }}
    >
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-[800px]">
        <DialogTitle>Выходные адреса · {rental.label || rental.endpoint}</DialogTitle>
        <DialogDescription>
          Вход {rental.endpoint} → ваши выходные ноды. Список заменяется целиком. TCP: до 3 основных и 2
          резервных; UDP: 1 основной и 1 резервный.
        </DialogDescription>
        <div className="min-h-0 overflow-y-auto space-y-3">
          {targets.map((t, i) => (
            <section key={t.rowId} className="rounded-[12px] border border-border bg-surface p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-[13px] font-semibold">Выход {i + 1}</h3>
                <RowButton
                  disabled={prepare.isPending || apply.isPending || uncertain}
                  onClick={() => {
                    setTargets(targets.filter((_, at) => at !== i));
                    prepare.reset();
                  }}
                >
                  <Trash2Icon />
                  Убрать
                </RowButton>
              </div>
              <SettingsRow label="Нода Remnawave" stack>
                <Select
                  disabled={prepare.isPending || apply.isPending || uncertain}
                  value={nodes.data?.nodes.find((n) => n.address === t.host)?.uuid ?? 'manual'}
                  onValueChange={(v) => {
                    const n = nodes.data?.nodes.find((n) => n.uuid === v);
                    if (n) update(i, { host: n.address, port: n.port ?? 443 });
                    else update(i, { host: '' });
                  }}
                >
                  <SelectTrigger aria-label={`Нода выхода ${i + 1}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Ввести адрес вручную</SelectItem>
                    {nodes.data?.nodes.map((n) => (
                      <SelectItem key={n.uuid} value={n.uuid}>
                        {n.name} · {n.address}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>
              <div className="grid grid-cols-[minmax(0,1fr)_100px_100px] gap-3 max-sm:grid-cols-1">
                <SettingsRow label="IP / домен" stack>
                  <Input
                    aria-label={`Адрес выхода ${i + 1}`}
                    disabled={prepare.isPending || apply.isPending || uncertain}
                    value={t.host}
                    onChange={(e) => update(i, { host: e.target.value })}
                  />
                </SettingsRow>
                <SettingsRow label="Порт" stack>
                  <Input
                    aria-label={`Порт выхода ${i + 1}`}
                    disabled={prepare.isPending || apply.isPending || uncertain}
                    type="number"
                    min={1}
                    max={65535}
                    value={t.port}
                    onChange={(e) => update(i, { port: Number(e.target.value) })}
                  />
                </SettingsRow>
                <SettingsRow label="Вес" stack>
                  <Input
                    aria-label={`Вес выхода ${i + 1}`}
                    disabled={prepare.isPending || apply.isPending || uncertain || t.backup}
                    type="number"
                    min={1}
                    max={256}
                    value={t.weight}
                    onChange={(e) => update(i, { weight: Number(e.target.value) })}
                  />
                </SettingsRow>
              </div>
              <label
                htmlFor={`rental-backup-${t.rowId}`}
                className="mt-3 flex items-center gap-2 text-[12.5px]"
              >
                <Checkbox
                  disabled={prepare.isPending || apply.isPending || uncertain}
                  id={`rental-backup-${t.rowId}`}
                  checked={t.backup}
                  onCheckedChange={(v) => update(i, { backup: v === true })}
                />
                Резервный выход
              </label>
            </section>
          ))}
          <RowButton
            disabled={targets.length >= 5 || prepare.isPending || apply.isPending || uncertain}
            onClick={() => {
              setTargets([
                ...targets,
                { host: '', port: 443, weight: 1, backup: false, rowId: crypto.randomUUID() },
              ]);
              prepare.reset();
            }}
          >
            <PlusIcon />
            Добавить выход
          </RowButton>
          {error && (
            <p role="alert" className="rounded-[10px] bg-crit-soft p-3 text-[13px] text-crit">
              {error}
            </p>
          )}
          {apply.data && (
            <div className="rounded-[10px] border border-border bg-surface-2 p-3 text-[13px]">
              <b>{uncertain ? 'Результат изменения пока неизвестен' : 'Изменение принято BS Checker'}</b>
              <p className="mt-1 text-text-3">
                {uncertain
                  ? 'Повтор использует тот же ключ изменения.'
                  : 'Точка ещё должна применить конфигурацию. В карточке отслеживается желаемая и применённая версия.'}
              </p>
              {apply.data.warnings.map((w) => (
                <p key={w} className="mt-1 text-warn">
                  {w}
                </p>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
          <RowButton disabled={apply.isPending} onClick={onClose}>
            Закрыть
          </RowButton>
          <CardButton
            disabled={
              !targets.length || prepare.isPending || apply.isPending || apply.data?.status === 'submitted'
            }
            onClick={() => (uncertain ? void execute() : void submit())}
          >
            {apply.isPending
              ? 'Сохраняю…'
              : uncertain
                ? 'Получить результат изменения'
                : 'Проверить и сохранить выходы'}
          </CardButton>
        </div>
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title="Заменить выходные адреса точки?"
          description={`Сейчас: ${prepare.data ? addresses(prepare.data.before) : '—'}. После: ${prepare.data ? addresses(prepare.data.after) : '—'}. Входящие подключения будут направляться на новый список.`}
          yesLabel="Заменить адреса"
          onConfirm={() => void execute()}
          loading={apply.isPending}
        />
      </DialogContent>
    </Dialog>
  );
}
