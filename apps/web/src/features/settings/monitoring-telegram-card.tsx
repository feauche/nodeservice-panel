import {
  type IncidentKind,
  TELEGRAM_EVENT_HINTS,
  TELEGRAM_EVENT_LABELS,
  TELEGRAM_KIND_HINTS,
  TELEGRAM_KIND_LABELS,
  type TelegramEvent,
} from '@nodeservice/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage } from '@/lib/api';
import { SettingsCard, SettingsCardSkeleton, SettingsRow, Toggle } from './settings-ui';
import { useTelegramSettings, useUpdateTelegram } from './telegram-api';

const kinds: IncidentKind[] = [
  'node_down',
  'node_blocked',
  'server_down',
  'wave',
  'cpu_high',
  'mem_high',
  'channel_high',
];
const events: TelegramEvent[] = ['incident_crit', 'incident_warn', 'resolved', 'reminder'];
type Draft = {
  kinds: Partial<Record<IncidentKind, boolean>>;
  events: Partial<Record<TelegramEvent, boolean>>;
};

/**
 * Какие события уходят в Telegram — черновик для общей полосы «Сохранить» раздела «События»: своей кнопки
 * у карточки нет, сохранение одно на раздел.
 */
export function useIncidentTelegramDraft() {
  const query = useTelegramSettings(),
    update = useUpdateTelegram();
  const data = query.data;
  const pick = useCallback(
    (): Draft | null =>
      data
        ? {
            kinds: Object.fromEntries(kinds.map((k) => [k, data.kinds[k]])),
            events: Object.fromEntries(events.map((k) => [k, data.events[k]])),
          }
        : null,
    [data],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => setDraft(pick()), [pick]);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(pick());
  return {
    query,
    draft,
    setDraft,
    dirty,
    pending: update.isPending,
    save: async () => {
      if (draft && dirty) await update.mutateAsync(draft);
    },
    reset: () => setDraft(pick()),
  };
}

export function IncidentTelegramCard({ state }: { state: ReturnType<typeof useIncidentTelegramDraft> }) {
  const { query, draft, setDraft } = state;
  if (query.isPending) return <SettingsCardSkeleton rows={kinds.length + events.length} />;
  return (
    <SettingsCard
      title="События в Telegram"
      hint="Выключенный вид остаётся в панели, но не отправляется в Telegram. Чаты, тихие часы и частота напоминаний — в разделе «Уведомления»."
    >
      {query.isError && (
        <p role="alert" className="py-3 text-crit">
          {apiErrorMessage(query.error)}
        </p>
      )}
      {draft && (
        <>
          {kinds.map((k) => (
            <SettingsRow
              key={k}
              label={TELEGRAM_KIND_LABELS[k]}
              hint={TELEGRAM_KIND_HINTS[k]}
              htmlFor={`tg-kind-${k}`}
            >
              <Toggle
                id={`tg-kind-${k}`}
                checked={!!draft.kinds[k]}
                onChange={(v) => setDraft({ ...draft, kinds: { ...draft.kinds, [k]: v } })}
              />
            </SettingsRow>
          ))}
          {events.map((k) => (
            <SettingsRow
              key={k}
              label={TELEGRAM_EVENT_LABELS[k]}
              hint={TELEGRAM_EVENT_HINTS[k]}
              htmlFor={`tg-ev-${k}`}
            >
              <Toggle
                id={`tg-ev-${k}`}
                checked={!!draft.events[k]}
                onChange={(v) => setDraft({ ...draft, events: { ...draft.events, [k]: v } })}
              />
            </SettingsRow>
          ))}
        </>
      )}
    </SettingsCard>
  );
}
