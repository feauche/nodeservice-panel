import {
  containerNameSchema,
  EXPECTED_CONTAINERS_MAX,
  EXPECTED_PORTS_MAX,
  MAINTENANCE_WINDOW_MAX,
  normalizeProfilePatch,
  portNumberSchema,
  SERVER_IMPORTANCE,
  SERVER_IMPORTANCE_LABELS,
  SERVER_ROLE_LABELS,
  SERVER_ROLES,
  type Server,
  type ServerInventory,
  type ServerProfile,
} from '@nodeservice/shared';
import { CheckIcon, Loader2Icon, PlusIcon, RefreshCwIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatAgo } from '@/features/security/security-format';
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
    expectedContainers: p.expectedContainers,
    expectedPorts: p.expectedPorts,
    maintenanceWindow: p.maintenanceWindow,
  });
  return {
    role: p.role,
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

/**
 * Вкладка «Профиль» (J3, вариант A5): роль, важность, окно обслуживания и таблица «ожидается / сейчас».
 * Профиль читает Джарвис; расхождения считает панель по снимку состояния, снятому по SSH.
 */
export function ProfileTab({ server }: { server: Server }) {
  const update = useUpdateServer();
  const refresh = useRefreshInventory();
  const saved = canon(server.profile);
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<ServerProfile>(saved);
  const dirty = JSON.stringify(canon(draft)) !== savedKey;

  // Другой сервер или профиль изменился со стороны (и своих правок нет): показываем сохранённое.
  // biome-ignore lint/correctness/useExhaustiveDependencies: сброс нужен при смене сервера и сохранённого профиля
  useEffect(() => {
    setDraft((cur) => (JSON.stringify(canon(cur)) === savedKey ? cur : saved));
  }, [server.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: см. выше
  useEffect(() => {
    if (!dirty) setDraft(saved);
  }, [savedKey]);

  const inventory = server.inventory;
  const rows = buildRows(draft, inventory);
  const bad = rows.filter((r) => r.state === 'bad').length;
  const expectedCount = draft.expectedContainers.length + draft.expectedPorts.length;

  const patch = (over: Partial<ServerProfile>) => setDraft((d) => ({ ...d, ...over }));
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
            role: c.role,
            importance: c.importance,
            maintenanceWindow: c.maintenanceWindow,
            expectedContainers: c.expectedContainers,
            expectedPorts: c.expectedPorts,
          },
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
      <p className="m-0 text-[12.5px] leading-normal text-text-3">
        Профиль читает Джарвис: он учитывает роль и важность в советах и сверяет ожидаемое с тем, что реально
        запущено. Сам он профиль не меняет.
      </p>

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

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-semibold">Роль</span>
          <Choice
            label="Роль сервера в парке"
            items={[...SERVER_ROLES].map((r) => ({ key: r, label: SERVER_ROLE_LABELS[r] }))}
            value={draft.role}
            onChange={(role) => patch({ role })}
            clearable
          />
          <span className="text-[11.5px] text-text-3">Зачем сервер нужен в вашей схеме.</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-semibold">Важность</span>
          <Choice
            label="Важность сервера"
            items={[...SERVER_IMPORTANCE].map((i) => ({ key: i, label: SERVER_IMPORTANCE_LABELS[i] }))}
            value={draft.importance}
            onChange={(importance) => importance && patch({ importance })}
          />
          <span className="text-[11.5px] text-text-3">
            Для критичного Джарвис называет последствия и окно обслуживания.
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="sm-window" className="text-[13px] font-semibold">
          Окно обслуживания
        </label>
        <Input
          id="sm-window"
          value={draft.maintenanceWindow ?? ''}
          maxLength={MAINTENANCE_WINDOW_MAX}
          placeholder="Например, ночью по Москве, 03:00–05:00"
          onChange={(e) => patch({ maintenanceWindow: e.target.value })}
          className="h-10 rounded-[10px] bg-surface-2"
        />
      </div>

      <section className="rounded-2xl border border-border bg-surface-2/40 p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="m-0 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
            Что должно работать
          </h3>
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

        {rows.length === 0 ? (
          <p className="m-0 py-2 text-[12.5px] leading-normal text-text-3">
            Ожидаемое не задано. Добавьте контейнеры и порты, которые должны работать
            {inventory ? ', или возьмите их из текущего состояния' : ''}. Панель сверит их со снимком и
            покажет расхождения.
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
            onClick={() => setDraft(saved)}
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
