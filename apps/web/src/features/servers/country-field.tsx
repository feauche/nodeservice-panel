import {
  COMMON_COUNTRY_CODES,
  type CountryChoice,
  countryList,
  countryName,
  type ServerCountry,
} from '@nodeservice/shared';
import { CircleHelpIcon, Loader2Icon, WandSparklesIcon } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';

import { CountryFlag } from '@/components/country-flag';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { formatAgo } from '@/features/security/security-format';
import { cn } from '@/lib/utils';
import { agreeText, countryView } from './country-text';

/** Значение первого пункта списка «Определять автоматически»: настоящие коды стран — две буквы. */
const AUTO = '__auto';

const AutoBadge = () => (
  <span className="flex-none rounded-[5px] bg-surface-3 px-1.5 py-px text-[10.5px] font-semibold text-text-3">
    авто
  </span>
);

const WandTile = () => (
  <span className="grid size-5 flex-none place-items-center rounded-[6px] bg-brand-soft text-brand">
    <WandSparklesIcon className="size-3.5" aria-hidden="true" />
  </span>
);

function buildOptions(): ComboOption[] {
  const all = countryList();
  const common = new Set<string>(COMMON_COUNTRY_CODES);
  const opt = (code: string, name: string, group: string): ComboOption => ({
    value: code,
    label: name,
    keywords: code,
    group,
    node: (
      <>
        <CountryFlag code={code} decorative />
        <span className="truncate">{name}</span>
        <span className="ml-auto flex-none font-mono text-[11px] text-text-3">{code}</span>
      </>
    ),
  });
  return [
    {
      value: AUTO,
      label: 'Определять автоматически',
      keywords: 'авто автоматически ip',
      pinned: true,
      node: (
        <>
          <WandTile />
          <span className="truncate">Определять автоматически</span>
          <span className="ml-auto flex-none text-[11.5px] text-text-3">по IP сервера</span>
        </>
      ),
    },
    ...COMMON_COUNTRY_CODES.map((c) => opt(c, countryName(c), 'Частые')),
    ...all.filter((c) => !common.has(c.code)).map((c) => opt(c.code, c.name, 'Все страны')),
  ];
}

const DESC = 'К какой стране относится сервер: флаг на карточке и фильтр «Страны».';

/** Выбор в поле: `null` — не трогали, остаётся то, что у сервера. */
export type CountryPick = CountryChoice | null;

interface View {
  display: ReactNode;
  hint: ReactNode;
  tone?: 'warn' | 'crit';
  value: string | null;
}

function viewOf(props: {
  variant: 'server' | 'create';
  country: ServerCountry | null;
  picked: CountryPick;
  host?: string | undefined;
}): View {
  const { variant, country, picked, host } = props;
  if (picked?.mode === 'auto' || (!picked && !country)) {
    return {
      value: AUTO,
      display: (
        <>
          <WandTile />
          <span>Определять автоматически</span>
        </>
      ),
      hint:
        variant === 'create'
          ? 'Если не выбрать, панель определит страну по IP сервера после добавления. Потом её можно поменять на вкладке «Подключение».'
          : 'Определится по IP сервера после сохранения.',
    };
  }
  const manualHint =
    variant === 'create'
      ? 'Выбрана вручную: автоопределение её не изменит.'
      : 'Выбрана вручную: автоопределение её не меняет. Чтобы вернуть автоматику, выберите первый пункт списка.';
  if (picked?.mode === 'manual') {
    const code = String(picked.code).toUpperCase();
    return {
      value: code,
      display: (
        <>
          <CountryFlag code={code} decorative />
          <span>{countryName(code)}</span>
        </>
      ),
      hint: manualHint,
    };
  }
  const c = country as ServerCountry;
  const view = countryView(c);
  const name = c.code ? countryName(c.code) : '';
  if (view === 'manual')
    return {
      value: c.code,
      display: (
        <>
          <CountryFlag code={c.code as string} decorative />
          <span>{name}</span>
        </>
      ),
      hint: manualHint,
    };
  const autoDisplay = c.code ? (
    <>
      <CountryFlag code={c.code} decorative />
      <span>{name}</span>
      <AutoBadge />
    </>
  ) : null;
  if (view === 'detecting')
    return {
      value: AUTO,
      display: (
        <>
          <Loader2Icon className="size-3.5 flex-none animate-spin text-brand" aria-hidden="true" />
          <span className="text-text-3">Определяю по IP{host ? ` ${host}` : ''}…</span>
        </>
      ),
      hint: 'Обычно до минуты. Страну можно выбрать вручную, не дожидаясь.',
    };
  if (view === 'failed')
    return {
      value: AUTO,
      display: autoDisplay ?? (
        <>
          <span className="grid h-[15px] w-[20px] flex-none place-items-center rounded-[3px] border border-dashed border-warn text-warn">
            <CircleHelpIcon className="size-[11px]" aria-hidden="true" />
          </span>
          <span className="text-text-3">Не определена</span>
        </>
      ),
      tone: 'crit',
      hint: `Не удалось определить: ${c.note ?? 'источники не ответили.'} Выберите страну вручную или повторите позже (пункт «Определять автоматически»).`,
    };
  if (view === 'auto')
    return {
      value: AUTO,
      display: autoDisplay,
      hint: (
        <>
          Определена автоматически{c.checkedAt ? ` ${formatAgo(c.checkedAt)}` : ''}
          {agreeText(c) ? `: совпали ${agreeText(c)}` : ''}.
        </>
      ),
    };
  return {
    value: AUTO,
    display: (
      <>
        <WandTile />
        <span>Определять автоматически</span>
      </>
    ),
    hint: 'Определится по IP сервера после добавления.',
  };
}

/**
 * Поле «Страна» (вариант A1 витрины): список как у провайдера, но без «Добавить…»; первый пункт «Определять
 * автоматически» включает автоопределение по IP сервера, выбор страны — ручной режим, который автоматика не трогает.
 * `variant: 'create'` — окно «Добавить сервер», `'server'` — вкладка «Подключение» (есть состояние сервера).
 */
export function CountryField({
  id,
  variant,
  country,
  picked,
  onPick,
  host,
  disabled,
  className,
}: {
  id: string;
  variant: 'server' | 'create';
  /** Состояние страны у сервера; в окне добавления его ещё нет. */
  country: ServerCountry | null;
  picked: CountryPick;
  onPick: (pick: CountryChoice) => void;
  host?: string;
  disabled?: boolean;
  className?: string;
}) {
  const options = useMemo(buildOptions, []);
  const view = viewOf({ variant, country, picked, host });
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Label htmlFor={id} className="flex items-center gap-2 text-[12.5px] font-medium text-text-2">
        Страна
        <span className="rounded-[5px] bg-surface-3 px-1.5 py-px text-[10.5px] font-semibold text-text-3">
          Необязательно
        </span>
      </Label>
      <p className="-mt-0.5 text-[12px] leading-normal text-text-3">{DESC}</p>
      <Combobox
        id={id}
        ariaLabel="Страна"
        value={view.value}
        onChange={(v) => {
          if (v === null) return;
          onPick(v === AUTO ? { mode: 'auto' } : { mode: 'manual', code: v });
        }}
        options={options}
        display={<span className="flex min-w-0 items-center gap-2">{view.display}</span>}
        placeholder={<span className="text-text-3">Не выбрана</span>}
        searchPlaceholder="Найти страну…"
        searchFrom={0}
        disabled={disabled}
        className="bg-surface-2"
      />
      <p
        id={`${id}-hint`}
        className={cn(
          'text-[12px] leading-normal text-text-3',
          view.tone === 'crit' && 'text-crit',
          view.tone === 'warn' && 'text-warn',
        )}
      >
        {view.hint}
      </p>
    </div>
  );
}
