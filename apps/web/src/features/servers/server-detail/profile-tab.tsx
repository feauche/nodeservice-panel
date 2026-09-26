import {
  containerNameSchema,
  EXPECTED_CONTAINERS_MAX,
  EXPECTED_PORTS_MAX,
  MAINTENANCE_WINDOW_MAX,
  type NodeWatch,
  normalizeProfilePatch,
  portNumberSchema,
  SERVER_IMPORTANCE,
  SERVER_IMPORTANCE_HINTS,
  SERVER_IMPORTANCE_LABELS,
  SERVER_ROLE_HINTS,
  SERVER_ROLE_LABELS,
  SERVER_ROLES,
  type Server,
  type ServerInventory,
  type ServerProfile,
  type ServerRole,
} from '@nodeservice/shared';
import {
  CheckIcon,
  InfoIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatAgo } from '@/features/security/security-format';
import { NodeStatePill, NodeWatchSegments } from '@/features/servers/node-watch-select';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useRefreshInventory, useUpdateServer } from '../servers-api';

type RowState = 'ok' | 'bad' | 'unknown';
interface Row {
  kind: 'container' | 'port';
  value: string | number;
  label: string;
  state: RowState;
  text: string;
}

/** Порядок и вид, в котором профиль хранит панель: по нему определяем, есть ли несохранённые правки. */
function canon(p: ServerProfile): ServerProfile {
  const n = normalizeProfilePatch({
    roles: p.roles,
    expectedContainers: p.expectedContainers,
    expectedPorts: p.expectedPorts,
    maintenanceWindow: p.maintenanceWindow,
  });
  return {
    roles: n.roles ?? [],
    importance: p.importance,
    maintenanceWindow: n.maintenanceWindow ?? null,
    expectedContainers: n.expectedContainers ?? [],
    expectedPorts: n.expectedPorts ?? [],
  };
}

/** Что ожидается и что видно по снимку: одна строка на контейнер или порт. */
export function buildRows(profile: ServerProfile, inventory: ServerInventory | null): Row[] {
  const rows: Row[] = [];
  for (const name of profile.expectedContainers) {
    const label = `Контейнер ${name}`;
    if (!inventory) {
      rows.push({ kind: 'container', value: name, label, state: 'unknown', text: 'Не проверялось' });
      continue;
    }
    const found = inventory.containers.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!found)
      rows.push({
        kind: 'container',
        value: name,
        label,
        state: 'bad',
        text: inventory.docker ? 'Нет на сервере' : 'Нет: на сервере не найден Docker',
      });
    else if (found.state !== 'running')
      rows.push({
        kind: 'container',
        value: name,
        label,
        state: 'bad',
        text: `Не работает (${found.state})`,
      });
    else rows.push({ kind: 'container', value: name, label, state: 'ok', text: 'Работает' });
  }
  for (const port of profile.expectedPorts) {
    const label = `Порт ${port}`;
    if (!inventory) {
      rows.push({ kind: 'port', value: port, label, state: 'unknown', text: 'Не проверялось' });
      continue;
    }
    const found = inventory.ports.find((p) => p.port === port);
    rows.push(
      found
        ? {
            kind: 'port',
            value: port,
            label,
            state: 'ok',
            text: `Слушает ${found.process ?? 'процесс'}${found.exposed ? '' : ' (только localhost)'}`,
          }
        : { kind: 'port', value: port, label, state: 'bad', text: 'Никто не слушает' },
    );
  }
  return rows;
}

/** Переключатель из нескольких вариантов; повторное нажатие на выбранный сбрасывает выбор, если это разрешено. */
function Choice<K extends string>({
  label,
  items,
  value,
  onChange,
  clearable,
}: {
  label: string;
  items: ReadonlyArray<{ key: K; label: string }>;
  value: K | null;
  onChange: (key: K | null) => void;
  clearable?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex gap-[3px] rounded-[11px] border border-border bg-surface-2 p-[3px]"
    >
      {items.map((it) => (
        // biome-ignore lint/a11y/useSemanticElements: см. группу выше
        <button
          key={it.key}
          type="button"
          role="radio"
          aria-checked={it.key === value}
          onClick={() => onChange(it.key === value && clearable ? null : it.key)}
          className={cn(
            'min-w-0 flex-1 cursor-pointer rounded-[8px] px-2 py-1.5 text-center text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-brand',
            it.key === value
              ? 'bg-surface font-semibold text-foreground shadow-[0_0_0_1px_var(--ns-border-2)]'
              : 'text-text-3 hover:text-foreground',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** «+ Контейнер» и «+ Порт»: маленькое поле по нажатию, Enter добавляет, Escape отменяет. */
function AddInline({
  label,
  placeholder,
  disabled,
  validate,
  onAdd,
  inputMode,
}: {
  label: string;
  placeholder: string;
  disabled?: boolean;
  validate: (raw: string) => string | null;
  onAdd: (raw: string) => void;
  inputMode?: 'numeric';
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setText('');
    setError(null);
  };
  const commit = () => {
    const bad = validate(text.trim());
    if (bad) {
      setError(bad);
      return;
    }
    onAdd(text.trim());
    close();
  };
  if (!open)
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[7px] bg-surface-3 px-2 text-[12px] text-text-3 transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <PlusIcon className="size-3" aria-hidden="true" />
        {label}
      </button>
    );
  return (
    <span className="inline-flex flex-col gap-1">
      <input
        // biome-ignore lint/a11y/noAutofocus: поле открывается по нажатию и должно сразу принимать ввод
        autoFocus
        aria-label={label}
        data-escape-local=""
        inputMode={inputMode}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        onBlur={() => !text.trim() && close()}
        className="h-6 w-40 rounded-[7px] border border-border bg-surface px-2 text-[12px] outline-none focus:border-brand/50"
      />
      {error && (
        <span role="alert" className="text-[11.5px] text-crit">
          {error}
        </span>
      )}
    </span>
  );
}

function StatusCell({ row }: { row: Row }) {
  const Icon = row.state === 'ok' ? CheckIcon : row.state === 'bad' ? XIcon : null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[12.5px]',
        row.state === 'ok' && 'font-semibold text-ok',
        row.state === 'bad' && 'font-semibold text-crit',
        row.state === 'unknown' && 'text-text-3',
      )}
    >
      {Icon ? <Icon className="size-3.5 flex-none" aria-hidden="true" /> : <span aria-hidden="true">—</span>}
      {row.text}
    </span>
  );
}

const H3 = 'm-0 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase';

/** Метка у полей, которые можно не заполнять. */
function Optional() {
  return (
    <span className="rounded-[6px] bg-surface-3 px-[7px] py-px text-[11px] font-medium whitespace-nowrap text-text-3">
      Необязательно
    </span>
  );
}

/** Функция сервера: галочка с названием и пояснением, отмечать можно несколько. */
function RoleCard({
  role,
  on,
  onToggle,
  wide,
}: {
  role: ServerRole;
  on: boolean;
  onToggle: () => void;
  wide?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: карточка-галочка с названием и пояснением, нативный чекбокс здесь не подходит
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-labelledby={`pf-role-${role}-l`}
      aria-describedby={`pf-role-${role}-d`}
      onClick={onToggle}
      className={cn(
        'flex min-w-0 cursor-pointer items-start gap-2.5 rounded-[11px] border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-brand',
        wide && 'sm:col-span-2',
        on ? 'border-brand/55 bg-brand-soft' : 'border-border bg-surface hover:bg-surface-3',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 grid size-4 flex-none place-items-center rounded-[5px] border-[1.5px]',
          on ? 'border-brand bg-brand text-cta-foreground' : 'border-border-2 text-transparent',
        )}
      >
        <CheckIcon className="size-[11px]" />
      </span>
      <span className="min-w-0">
        <b id={`pf-role-${role}-l`} className="block text-[13px] font-semibold">
          {SERVER_ROLE_LABELS[role]}
        </b>
        <small id={`pf-role-${role}-d`} className="mt-px block text-[12px] leading-snug text-text-2">
          {SERVER_ROLE_HINTS[role]}
        </small>
      </span>
    </button>
  );
}

/**
 * Вкладка «Профиль» (J3, вариант A5 + R2): нода Remnawave, функции сервера, важность, окно обслуживания и
 * таблица «ожидается / сейчас». Профиль читает Джарвис; расхождения считает панель по снимку состояния по SSH.
 */
export function ProfileTab({ server }: { server: Server }) {
  const update = useUpdateServer();
  const refresh = useRefreshInventory();
  const saved = canon(server.profile);
  const savedKey = JSON.stringify([saved, server.nodeWatch]);
  const [draft, setDraft] = useState<ServerProfile>(saved);
  const [nodeWatch, setNodeWatch] = useState<NodeWatch>(server.nodeWatch);
  const dirty = JSON.stringify([canon(draft), nodeWatch]) !== savedKey;
  const reset = () => {
    setDraft(saved);
    setNodeWatch(server.nodeWatch);
  };

  // Другой сервер или сохранённое изменилось со стороны (и своих правок нет): показываем сохранённое.
  // biome-ignore lint/correctness/useExhaustiveDependencies: сброс нужен при смене сервера и сохранённого профиля
  useEffect(reset, [server.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: см. выше
  useEffect(() => {
    if (!dirty) reset();
  }, [savedKey]);

  const inventory = server.inventory;
  const rows = buildRows(draft, inventory);
  const bad = rows.filter((r) => r.state === 'bad').length;
  const expectedCount = draft.expectedContainers.length + draft.expectedPorts.length;

  const patch = (over: Partial<ServerProfile>) => setDraft((d) => ({ ...d, ...over }));
  const toggleRole = (role: ServerRole) =>
    patch({
      roles: SERVER_ROLES.filter((r) => (r === role ? !draft.roles.includes(r) : draft.roles.includes(r))),
    });
  const remove = (r: Row) =>
    patch(
      r.kind === 'container'
        ? { expectedContainers: draft.expectedContainers.filter((c) => c !== r.value) }
        : { expectedPorts: draft.expectedPorts.filter((p) => p !== r.value) },
    );

  const adopt = () => {
    if (!inventory) return;
    const containers = inventory.containers
      .filter((c) => c.state === 'running' && containerNameSchema.safeParse(c.name).success)
      .map((c) => c.name);
    const ports = inventory.ports.filter((p) => p.exposed).map((p) => p.port);
    patch({
      expectedContainers: [...new Set([...draft.expectedContainers, ...containers])]
        .sort()
        .slice(0, EXPECTED_CONTAINERS_MAX),
      expectedPorts: [...new Set([...draft.expectedPorts, ...ports])]
        .sort((a, b) => a - b)
        .slice(0, EXPECTED_PORTS_MAX),
    });
  };

  const doRefresh = async () => {
    try {
      await refresh.mutateAsync(server.id);
      toast.success('Состояние сервера обновлено.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const save = async () => {
    const c = canon(draft);
    try {
      const next = await update.mutateAsync({
        id: server.id,
        patch: {
          profile: {
            roles: c.roles,
            importance: c.importance,
            maintenanceWindow: c.maintenanceWindow,
            expectedContainers: c.expectedContainers,
            expectedPorts: c.expectedPorts,
          },
          nodeWatch,
        },
      });
      toast.success('Профиль сохранён.');
      // Снимка ещё нет, а ожидаемое задано: снимаем состояние сразу, чтобы таблица показала, как обстоят дела.
      if (!next.inventory && (c.expectedContainers.length > 0 || c.expectedPorts.length > 0))
        void refresh.mutateAsync(server.id).catch(() => undefined);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const summary =
    expectedCount === 0
      ? { tone: 'muted', text: 'Ожидаемое не задано' }
      : !inventory
        ? { tone: 'muted', text: 'Состояние ещё не снималось' }
        : bad > 0
          ? { tone: 'warn', text: `Не совпадает с ожидаемым: ${bad}` }
          : { tone: 'ok', text: 'Всё совпадает с ожидаемым' };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5 rounded-[10px] border border-l-[3px] border-border border-l-brand bg-surface px-3 py-2.5 text-[12.5px] leading-normal text-text-2">
        <InfoIcon className="mt-0.5 size-[15px] flex-none text-brand" aria-hidden="true" />
        <p className="m-0">
          <b className="font-semibold text-foreground">Зачем.</b> Джарвис по этим данным понимает, что
          сломается при сбое, и осторожнее предлагает перезапуск. Заполнять необязательно: без профиля он
          работает как раньше.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          data-testid="profile-summary"
          className={cn(
            'inline-flex min-h-[26px] items-center gap-1.5 rounded-[9px] border px-2.5 text-[12.5px] font-medium',
            summary.tone === 'warn' && 'border-warn/40 bg-warn-soft text-warn',
            summary.tone === 'ok' && 'border-ok/30 bg-ok-soft text-ok',
            summary.tone === 'muted' && 'border-border bg-surface-2 text-text-2',
          )}
        >
          {summary.tone === 'warn' && <TriangleAlertIcon className="size-3.5" aria-hidden="true" />}
          {summary.text}
        </span>
        <span className="flex-1" />
        <span className="text-[12px] text-text-3">
          {inventory ? `Снимок ${formatAgo(inventory.at)}` : 'Снимка ещё нет'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={refresh.isPending}
          onClick={() => void doRefresh()}
          className="h-8 gap-1.5 rounded-[9px] px-3 text-[12.5px]"
        >
          {refresh.isPending ? (
            <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCwIcon className="size-3.5" aria-hidden="true" />
          )}
          Обновить состояние
        </Button>
      </div>

      <section
        aria-labelledby="pf-node"
        className="flex flex-col gap-2 rounded-2xl border border-border bg-surface-2/40 p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="pf-node" className={H3}>
            Нода Remnawave на сервере
          </h3>
          <NodeStatePill server={{ node: server.node, nodeWatch }} />
        </div>
        <p className="m-0 text-[12px] leading-normal text-text-3">
          Первый вопрос: от него зависят инциденты. Панель следит за контейнером ноды и сообщает, если он
          остановился.
        </p>
        <NodeWatchSegments value={nodeWatch} disabled={update.isPending} onChange={setNodeWatch} />
      </section>

      <section aria-labelledby="pf-roles" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="pf-roles" className={H3}>
            Что делает сервер
          </h3>
          <Optional />
        </div>
        <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0 sm:grid-cols-2">
          <legend className="sr-only">Что делает сервер</legend>
          {SERVER_ROLES.map((r) => (
            <RoleCard
              key={r}
              role={r}
              on={draft.roles.includes(r)}
              onToggle={() => toggleRole(r)}
              wide={r === 'other'}
            />
          ))}
        </fieldset>
        <p className="m-0 text-[12px] leading-normal text-text-3">
          Отметьте всё, что подходит. В простой схеме один сервер и принимает клиентов, и выпускает трафик.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold">Важность</span>
            <Optional />
          </div>
          <Choice
            label="Важность сервера"
            items={[...SERVER_IMPORTANCE].map((i) => ({ key: i, label: SERVER_IMPORTANCE_LABELS[i] }))}
            value={draft.importance}
            onChange={(importance) => importance && patch({ importance })}
          />
          <ul
            aria-label="Что значит каждая важность"
            className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] leading-snug"
          >
            {SERVER_IMPORTANCE.map((i) => {
              const on = draft.importance === i;
              return (
                <li
                  key={i}
                  data-selected={on}
                  className={cn(
                    'rounded-[9px] px-2.5 py-1.5',
                    on ? 'bg-brand-soft text-text-2' : 'text-text-3',
                  )}
                >
                  <b className={cn('font-semibold', on ? 'text-foreground' : 'text-text-2')}>
                    {SERVER_IMPORTANCE_LABELS[i]}.
                  </b>{' '}
                  {SERVER_IMPORTANCE_HINTS[i]}
                </li>
              );
            })}
          </ul>
          <p className="m-0 text-[11.5px] text-text-3">Сейчас важность влияет только на советы Джарвиса.</p>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="sm-window" className="text-[13px] font-semibold">
              Окно обслуживания
            </label>
            <Optional />
          </div>
          <Input
            id="sm-window"
            value={draft.maintenanceWindow ?? ''}
            maxLength={MAINTENANCE_WINDOW_MAX}
            placeholder="Например, ночью по Москве, 03:00–05:00"
            onChange={(e) => patch({ maintenanceWindow: e.target.value })}
            className="h-10 rounded-[10px] bg-surface-2"
          />
          <p className="m-0 text-[12px] leading-normal text-text-3">
            Когда можно обновлять и перезагружать сервер. Джарвис учтёт это, когда будет предлагать такие
            шаги.
          </p>
        </div>
      </div>

      <section className="rounded-2xl border border-border bg-surface-2/40 p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className={H3}>Что должно работать</h3>
          <Optional />
          <span className="flex-1" />
          {inventory && (
            <button
              type="button"
              onClick={adopt}
              className="cursor-pointer text-[12px] font-medium text-brand hover:underline"
            >
              Взять из текущего состояния
            </button>
          )}
        </div>

        <p className="m-0 mb-2 text-[12px] leading-normal text-text-3">
          Контейнеры и порты, которые обязаны быть в порядке. Например: remnanode, порт 443. Панель сверит их
          с состоянием сервера и покажет расхождения.
        </p>

        {rows.length === 0 ? (
          <p className="m-0 py-1 text-[12.5px] leading-normal text-text-2">
            Пока ничего не добавлено. Добавьте контейнеры и порты кнопками ниже
            {inventory ? ' или возьмите их из текущего состояния' : ''}.
          </p>
        ) : (
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="text-left text-[11.5px] text-text-3">
                <th className="px-2 py-1.5 font-semibold">Ожидается</th>
                <th className="px-2 py-1.5 font-semibold">Сейчас</th>
                <th className="w-8 px-2 py-1.5">
                  <span className="sr-only">Убрать</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.kind}:${r.value}`} className="border-t border-border">
                  <td className="px-2 py-2">{r.label}</td>
                  <td className="px-2 py-2">
                    <StatusCell row={r} />
                  </td>
                  <td className="px-1 py-1 text-right">
                    <button
                      type="button"
                      aria-label={`Убрать: ${r.label}`}
                      onClick={() => remove(r)}
                      className="grid size-6 cursor-pointer place-items-center rounded-[6px] text-text-3 hover:bg-surface-3 hover:text-foreground"
                    >
                      <XIcon className="size-3.5" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="mt-3 flex flex-wrap items-start gap-2">
          <AddInline
            label="Контейнер"
            placeholder="Имя, например remnanode"
            disabled={draft.expectedContainers.length >= EXPECTED_CONTAINERS_MAX}
            validate={(raw) => {
              if (!containerNameSchema.safeParse(raw).success)
                return 'Имя контейнера: буквы, цифры, точка, дефис, подчёркивание.';
              return draft.expectedContainers.some((c) => c.toLowerCase() === raw.toLowerCase())
                ? 'Такой контейнер уже в списке.'
                : null;
            }}
            onAdd={(raw) => patch({ expectedContainers: [...draft.expectedContainers, raw] })}
          />
          <AddInline
            label="Порт"
            placeholder="Номер, например 443"
            inputMode="numeric"
            disabled={draft.expectedPorts.length >= EXPECTED_PORTS_MAX}
            validate={(raw) => {
              const n = portNumberSchema.safeParse(raw);
              if (!n.success) return 'Порт: число от 1 до 65535.';
              return draft.expectedPorts.includes(n.data) ? 'Такой порт уже в списке.' : null;
            }}
            onAdd={(raw) => patch({ expectedPorts: [...draft.expectedPorts, Number(raw)] })}
          />
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={!dirty || update.isPending}
          onClick={() => void save()}
          className="rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover) disabled:opacity-50"
        >
          {update.isPending ? 'Сохраняю…' : 'Сохранить'}
        </Button>
        {dirty && (
          <Button
            type="button"
            variant="outline"
            disabled={update.isPending}
            onClick={reset}
            className="rounded-[10px] px-4"
          >
            Отменить
          </Button>
        )}
        {dirty && <span className="text-[12px] text-text-3">Есть несохранённые изменения</span>}
      </div>
    </div>
  );
}
