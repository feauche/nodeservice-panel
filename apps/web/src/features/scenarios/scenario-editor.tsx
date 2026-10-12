import {
  formatScenarioHostName,
  type Scenario,
  scenarioActionLabels,
  scenarioConditionDescriptions,
  scenarioConditions,
  scenarioHostsSchema,
  scenarioLabels,
} from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BellIcon,
  ClipboardListIcon,
  EyeOffIcon,
  GitBranchIcon,
  GlobeIcon,
  NetworkIcon,
  ServerIcon,
  TypeIcon,
} from 'lucide-react';
import { type Dispatch, type SetStateAction, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RowsSkeleton } from '@/components/ui/loading-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useNodes } from '@/features/nodes/nodes-api';
import { useMonitoring } from '@/features/settings/settings-api';
import { BarButton, CardButton, Pill, Segmented } from '@/features/settings/settings-ui';
import { useTelegramSettings } from '@/features/settings/telegram-api';
import { api, apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

const icons = {
  check_tcp: NetworkIcon,
  record_event: ClipboardListIcon,
  notify: BellIcon,
  hide_host: EyeOffIcon,
  rename_host: TypeIcon,
};
export function ScenarioEditor({
  draft,
  setDraft,
  busy,
  onSave,
  onClose,
  onDelete,
  error,
}: {
  draft: Scenario;
  setDraft: Dispatch<SetStateAction<Scenario | null>>;
  busy: boolean;
  onSave: () => void;
  onClose: () => void;
  onDelete?: () => void;
  error: string | null;
}) {
  const nodes = useNodes(),
    [search, setSearch] = useState('');
  const [holdInput, setHoldInput] = useState(String(draft.holdMinutes));
  const [cooldownInput, setCooldownInput] = useState(String(draft.cooldownMinutes));
  const timeValid = (v: string, min: number, max: number) =>
    v.trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
  const conditions = scenarioConditions(draft);
  const telegram = useTelegramSettings();
  const monitoring = useMonitoring();
  const hosts = useQuery({
    queryKey: ['scenario-hosts'],
    queryFn: ({ signal }) => api.get('/scenarios/hosts', scenarioHostsSchema, signal),
    enabled: draft.actions.some((a) => a === 'hide_host' || a === 'rename_host'),
    staleTime: 15000,
  });
  const visibleNodes = (nodes.data?.nodes ?? []).filter((n) =>
    `${n.name} ${n.address}`.toLowerCase().includes(search.toLowerCase()),
  );
  const allowedNodes = (nodes.data?.nodes ?? []).filter(
    (n) => draft.scope === 'all' || draft.nodes.includes(n.uuid),
  );
  const targets = (hosts.data?.hosts ?? [])
    .map((h) => {
      const manual = draft.hostBindings.find((b) => b.hostUuid === h.uuid);
      const ids = manual && !h.nodes.length ? [manual.nodeUuid] : h.nodes;
      return {
        ...h,
        nodes: ids,
        nodeNames: ids.map((id) => nodes.data?.nodes.find((n) => n.uuid === id)?.name ?? id),
        automaticNodes: h.nodes,
      };
    })
    .filter(
      (h) => !h.nodes.length || draft.scope === 'all' || h.nodes.some((id) => draft.nodes.includes(id)),
    );
  const change = (v: Partial<Scenario>) => {
    const next = { ...draft, ...v };
    if (next.scope === 'selected')
      next.hostBindings = next.hostBindings.filter((b) => next.nodes.includes(b.nodeUuid));
    setDraft(next);
  };
  const name = (before: string) => formatScenarioHostName(before, draft.renameMode, draft.renameText);
  const reorder = (action: Scenario['actions'][number], delta: number) => {
    const actions = [...draft.actions],
      i = actions.indexOf(action),
      j = i + delta;
    if (j < 0 || j >= actions.length) return;
    [actions[i], actions[j]] = [actions[j], actions[i]];
    change({ actions });
  };
  const title = (n: number, text: string) => (
    <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
      <span className="grid size-6 place-items-center rounded-lg bg-brand-soft text-xs text-brand">{n}</span>
      {text}
    </h3>
  );
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <DialogContent className="flex h-[min(860px,90dvh)] max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[960px]">
        <header className="shrink-0 border-b border-border px-5 py-4 pr-14">
          <DialogTitle className="flex items-center gap-2">
            <GitBranchIcon className="size-5 text-brand" />
            {onDelete ? 'Настроить сценарий' : 'Новый сценарий'}
          </DialogTitle>
          <DialogDescription className="mt-2">
            Условие, ноды и действия. Справа — результат и затронутые Host.
          </DialogDescription>
        </header>
        <div className="grid min-h-0 flex-1 overflow-y-auto lg:overflow-hidden lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-h-0 min-w-0 space-y-5 p-5 lg:overflow-y-auto">
            <label htmlFor="scenario-field-1" className="block text-xs font-medium text-text-2">
              Название
              <Input
                id="scenario-field-1"
                className="mt-2 h-10"
                value={draft.name}
                onChange={(e) => change({ name: e.target.value })}
              />
            </label>
            <section>
              {title(1, 'Когда запускать')}
              <div className="space-y-3">
                <Segmented
                  label="Логика условий"
                  value={draft.conditionMode}
                  onChange={(value) => change({ conditionMode: value as Scenario['conditionMode'] })}
                  items={[
                    { key: 'all', label: 'И · все условия' },
                    { key: 'any', label: 'ИЛИ · любое' },
                  ]}
                />
                {conditions.map((condition, index) => (
                  <div key={condition} className="rounded-xl border border-border bg-surface-2 p-3">
                    <div className="flex items-center gap-2">
                      <Select
                        value={condition}
                        onValueChange={(value) =>
                          change({
                            conditions: conditions.map((c, i) =>
                              i === index ? (value as Scenario['trigger']) : c,
                            ),
                          })
                        }
                      >
                        <SelectTrigger aria-label={`Условие ${index + 1}`} className="h-10 flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(scenarioLabels)
                            .filter(
                              ([key]) =>
                                key === condition || !conditions.includes(key as Scenario['trigger']),
                            )
                            .map(([key, text]) => (
                              <SelectItem key={key} value={key}>
                                {text}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      {conditions.length > 1 && (
                        <BarButton
                          className="size-10 min-w-0 p-0"
                          aria-label={`Удалить условие ${index + 1}`}
                          onClick={() => change({ conditions: conditions.filter((_, i) => i !== index) })}
                        >
                          ×
                        </BarButton>
                      )}
                    </div>
                    <p className="mt-2 text-xs leading-5 text-text-3">
                      {scenarioConditionDescriptions[condition]}
                    </p>
                  </div>
                ))}
                {conditions.length < 3 && (
                  <BarButton
                    className="h-10"
                    onClick={() => {
                      const next = (Object.keys(scenarioLabels) as Scenario['trigger'][]).find(
                        (c) => !conditions.includes(c),
                      );
                      if (next) change({ conditions: [...conditions, next] });
                    }}
                  >
                    Добавить условие
                  </BarButton>
                )}
                {monitoring.data &&
                  (!monitoring.data.enabled ||
                    (conditions.includes('tcp_unreachable') && !monitoring.data.checkHostEnabled)) && (
                    <p
                      className="rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs leading-5"
                      role="status"
                    >
                      {!monitoring.data.enabled
                        ? 'Мониторинг нод выключен — сценарий не выполнится.'
                        : 'TCP-проверки выключены — условие «TCP недоступен» не подтвердится.'}{' '}
                      <a href="/settings/autochecks" className="text-brand hover:underline">
                        Настройки автопроверок →
                      </a>
                    </p>
                  )}
                {conditions.includes('tcp_unreachable') && monitoring.data?.checkHostEnabled && (
                  <p className="text-xs leading-5 text-text-3">
                    TCP проверяется раз в {monitoring.data.checkHostCooldownMinutes} мин; неполный результат —
                    повтор через минуту. Основной порт: {monitoring.data.checkHostPort}, также проверяется
                    порт ноды.
                  </p>
                )}
                <label htmlFor="scenario-field-3" className="block text-xs text-text-2">
                  Подтверждение всей группы, минут
                  <Input
                    id="scenario-field-3"
                    className="mt-2 h-10"
                    type="number"
                    min={1}
                    max={60}
                    aria-invalid={!timeValid(holdInput, 1, 60)}
                    value={holdInput}
                    onChange={(e) => {
                      setHoldInput(e.target.value);
                      if (e.target.value !== '') change({ holdMinutes: Number(e.target.value) });
                    }}
                  />
                  <span className="mt-2 block text-[11px] text-text-3">
                    Условия должны сохраняться в течение этого времени. И — все одновременно; ИЛИ — хотя бы
                    одно.
                  </span>
                </label>
              </div>
            </section>
            <section>
              {title(2, 'Какие ноды')}
              <Segmented
                label="Область сценария"
                value={draft.scope}
                onChange={(v) =>
                  change({ scope: v as Scenario['scope'], nodes: v === 'all' ? [] : draft.nodes })
                }
                items={[
                  { key: 'all', label: 'Все ноды' },
                  { key: 'selected', label: 'Выбранные' },
                ]}
              />
              {draft.scope === 'all' ? (
                <div className="mt-3 flex items-center gap-3 rounded-xl border border-border bg-surface-2 p-3">
                  <GlobeIcon className="size-5 text-brand" />
                  <div className="text-sm">
                    Общий сценарий
                    <span className="block text-xs text-text-3">
                      Применяется к каждой ноде при её собственном сбое.
                    </span>
                  </div>
                </div>
              ) : (
                <div className="mt-3 rounded-xl border border-border p-3">
                  <Input
                    className="h-10"
                    placeholder="Найти ноду"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <div className="mt-2 flex justify-between text-xs">
                    <button
                      type="button"
                      className="text-brand"
                      onClick={() => change({ nodes: visibleNodes.map((n) => n.uuid) })}
                    >
                      Выбрать все
                    </button>
                    <button type="button" className="text-text-3" onClick={() => change({ nodes: [] })}>
                      Очистить
                    </button>
                  </div>
                  <div className="mt-3 grid max-h-36 gap-2 overflow-y-auto sm:grid-cols-2">
                    {visibleNodes.map((n) => (
                      <label
                        htmlFor={`scenario-node-${n.uuid}`}
                        key={n.uuid}
                        className="flex min-w-0 items-center gap-2 text-xs"
                      >
                        <Checkbox
                          id={`scenario-node-${n.uuid}`}
                          checked={draft.nodes.includes(n.uuid)}
                          onCheckedChange={(v) =>
                            change({
                              nodes: v ? [...draft.nodes, n.uuid] : draft.nodes.filter((id) => id !== n.uuid),
                            })
                          }
                        />
                        <span className="truncate">{n.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </section>
            <section>
              {title(3, 'Что делать')}
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.entries(scenarioActionLabels).map(([key, text]) => {
                  const action = key as Scenario['actions'][number],
                    Icon = icons[action],
                    checked = draft.actions.includes(action);
                  return (
                    <label
                      htmlFor={`scenario-action-${action}`}
                      key={action}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-xl border p-3 text-xs transition-colors',
                        checked
                          ? 'border-brand/40 bg-brand-soft'
                          : 'border-border bg-surface-2 hover:border-brand/30',
                      )}
                    >
                      <Checkbox
                        id={`scenario-action-${action}`}
                        aria-label={text}
                        checked={checked}
                        onCheckedChange={(v) =>
                          change({
                            actions: v
                              ? [...draft.actions, action]
                              : draft.actions.filter((a) => a !== action),
                          })
                        }
                      />
                      <Icon className={cn('size-4 shrink-0', checked ? 'text-brand' : 'text-text-3')} />
                      {text}
                    </label>
                  );
                })}
              </div>
              {draft.actions.includes('notify') && (
                <div
                  className="mt-3 rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs leading-5"
                  role="status"
                >
                  {telegram.isPending
                    ? 'Проверяем настройки Telegram…'
                    : telegram.isError
                      ? 'Не удалось проверить настройки Telegram. Проверьте подключение перед включением сценария.'
                      : !telegram.data?.destinations.length
                        ? 'Сообщение не придёт: Telegram не подключён.'
                        : !telegram.data.events.scenario
                          ? 'Сообщение не придёт: «Уведомления из сценариев» выключены в настройках.'
                          : 'Уведомления из сценариев включены. Действуют тихие часы и ограничения доставки Telegram.'}
                  <a href="/settings/notifications" className="mt-1 block text-brand hover:underline">
                    Настройки уведомлений →
                  </a>
                </div>
              )}
              {draft.actions.includes('rename_host') && (
                <div className="mt-3 space-y-3 rounded-xl border border-border bg-surface-2 p-3">
                  <label htmlFor="scenario-field-6" className="block text-xs text-text-2">
                    Как изменить имя
                    <Select
                      value={draft.renameMode}
                      onValueChange={(v) => change({ renameMode: v as Scenario['renameMode'] })}
                    >
                      <SelectTrigger id="scenario-field-6" className="mt-2 h-10">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="replace">Заменить целиком</SelectItem>
                        <SelectItem value="prepend">Добавить в начало, после флага</SelectItem>
                        <SelectItem value="append">Добавить в конец</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <label htmlFor="scenario-field-7" className="block text-xs text-text-2">
                    Текст или эмодзи
                    <Input
                      id="scenario-field-7"
                      className="mt-2 h-10"
                      placeholder="Например: 🔴 или временно недоступен"
                      aria-describedby="scenario-name-spacing"
                      value={draft.renameText}
                      onChange={(e) => change({ renameText: e.target.value })}
                    />
                    <span id="scenario-name-spacing" className="mt-2 block text-[11px] text-text-3">
                      Пробел до и после текста добавляется автоматически. В предпросмотре · означает пробел.
                    </span>
                  </label>
                </div>
              )}
              {draft.actions.some((a) => a === 'hide_host' || a === 'rename_host') && (
                <label
                  htmlFor="scenario-field-8"
                  className="mt-3 flex items-start gap-2 rounded-xl border border-border p-3 text-xs"
                >
                  <Checkbox
                    id="scenario-field-8"
                    checked={draft.autoRestore}
                    onCheckedChange={(v) => change({ autoRestore: !!v })}
                  />
                  <span>
                    Вернуть исходные параметры Host после восстановления
                    <span className="mt-1 block text-text-3">
                      Только для изменений этого сценария с подтверждённой и неизменённой версией Host.
                    </span>
                  </span>
                </label>
              )}
            </section>
            <label htmlFor="scenario-field-9" className="block text-xs text-text-2">
              Пауза между повторными сбоями, минут
              <Input
                id="scenario-field-9"
                className="mt-2 h-10"
                type="number"
                min={5}
                max={1440}
                aria-invalid={!timeValid(cooldownInput, 5, 1440)}
                value={cooldownInput}
                onChange={(e) => {
                  setCooldownInput(e.target.value);
                  if (e.target.value !== '') change({ cooldownMinutes: Number(e.target.value) });
                }}
              />
            </label>
          </div>
          <aside className="min-h-0 min-w-0 space-y-4 lg:overflow-y-auto border-l border-border bg-bg-2 p-5 max-lg:border-l-0 max-lg:border-t">
            <h3 className="text-sm font-semibold">Последовательность</h3>
            <div className="space-y-2">
              {[
                ...draft.actions.filter((a) => a !== 'notify'),
                ...(draft.actions.includes('notify') ? ['notify' as const] : []),
              ].map((a, i) => (
                <div
                  key={a}
                  className="flex items-center gap-2 rounded-xl border border-border bg-surface p-3"
                >
                  <span className="text-xs text-brand">{i + 1}</span>
                  <span className="flex-1 text-xs">{scenarioActionLabels[a]}</span>
                  {a !== 'notify' && (
                    <div className="flex gap-1">
                      <button
                        type="button"
                        aria-label={`Выше: ${scenarioActionLabels[a]}`}
                        onClick={() => reorder(a, -1)}
                        className="grid size-8 place-items-center rounded-md hover:bg-surface-2"
                      >
                        <ArrowUpIcon className="size-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Ниже: ${scenarioActionLabels[a]}`}
                        onClick={() => reorder(a, 1)}
                        className="grid size-8 place-items-center rounded-md hover:bg-surface-2"
                      >
                        <ArrowDownIcon className="size-3" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="text-xs leading-5 text-text-3">
              Уведомление — после действий. Один запуск на сбой; общие и индивидуальные правила независимы.
            </p>
            {draft.actions.some((a) => a === 'hide_host' || a === 'rename_host') && (
              <>
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <ServerIcon className="size-4 text-brand" />
                  Затронутые Host
                </h3>
                <p className="text-xs leading-5 text-text-3">
                  Host связываются по адресу или UUID. Если связь не определена, назначьте ноду вручную. Общие
                  Host пропускаются.
                </p>
                {hosts.isPending ? (
                  <RowsSkeleton rows={2} />
                ) : hosts.isError ? (
                  <p role="alert" className="text-xs text-crit">
                    {apiErrorMessage(hosts.error)}
                  </p>
                ) : !targets.length ? (
                  <p className="text-xs text-text-3">У выбранных нод нет связанных Host.</p>
                ) : (
                  <div className="space-y-2">
                    {targets.map((h) => (
                      <div key={h.uuid} className="rounded-xl border border-border bg-surface p-3">
                        <strong className="block break-words text-xs">{h.name}</strong>
                        {draft.actions.includes('rename_host') &&
                          draft.renameText &&
                          h.nodes.length === 1 && (
                            <div className="mt-2 flex items-start gap-2 text-xs text-brand">
                              <ArrowRightIcon className="mt-0.5 size-3 shrink-0" />
                              <span className="break-words">{name(h.name).replaceAll(' ', '·')}</span>
                            </div>
                          )}
                        <p className="mt-1 break-all text-[11px] text-text-3">
                          {h.address}
                          {h.port ? `:${h.port}` : ''}
                        </p>
                        <p className="mt-1 text-[11px] text-text-3">
                          {h.nodeNames.join(', ') || 'Нода не назначена'}
                        </p>
                        <p className="mt-1 text-[11px] text-text-3">
                          {h.automaticNodes.length
                            ? h.bindingSource
                            : draft.hostBindings.some((b) => b.hostUuid === h.uuid)
                              ? 'Ручная привязка в этом сценарии'
                              : 'Нет однозначной связи'}
                        </p>
                        {!h.automaticNodes.length && (
                          <Select
                            value={draft.hostBindings.find((b) => b.hostUuid === h.uuid)?.nodeUuid ?? 'auto'}
                            onValueChange={(value) =>
                              change({
                                hostBindings: [
                                  ...draft.hostBindings.filter((b) => b.hostUuid !== h.uuid),
                                  ...(value === 'auto' ? [] : [{ hostUuid: h.uuid, nodeUuid: value }]),
                                ],
                              })
                            }
                          >
                            <SelectTrigger aria-label={`Нода для Host ${h.name}`} className="mt-2 h-10">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="auto">Не изменять этот Host</SelectItem>
                              {allowedNodes.map((n) => (
                                <SelectItem key={n.uuid} value={n.uuid}>
                                  {n.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        <div className="mt-2">
                          <Pill tone={h.nodes.length !== 1 ? 'warn' : 'muted'}>
                            {h.nodes.length !== 1
                              ? 'Пропускается'
                              : draft.actions.includes('hide_host') &&
                                  h.disabled &&
                                  !draft.actions.includes('rename_host')
                                ? 'Уже выключен'
                                : 'Будет изменён'}
                          </Pill>
                        </div>
                        {h.restoration && <p className="mt-1 text-[11px] text-warn">{h.restoration}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </aside>
        </div>
        {error && (
          <p role="alert" className="px-5 py-2 text-xs text-crit">
            {error}
          </p>
        )}
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-bg-2 px-5 py-4">
          <BarButton className="h-10 min-w-28" disabled={busy} onClick={onClose}>
            Отмена
          </BarButton>
          <div className="flex gap-2">
            {onDelete && (
              <BarButton className="h-10" disabled={busy} onClick={onDelete}>
                Удалить
              </BarButton>
            )}
            <CardButton
              className="h-10 min-w-28"
              disabled={
                busy ||
                !timeValid(holdInput, 1, 60) ||
                !timeValid(cooldownInput, 5, 1440) ||
                draft.name.trim().length < 2 ||
                !draft.actions.length ||
                (draft.scope === 'selected' && !draft.nodes.length) ||
                (draft.actions.includes('rename_host') && !draft.renameText.trim())
              }
              onClick={onSave}
            >
              Сохранить
            </CardButton>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
