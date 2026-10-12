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
import { toast } from '@/lib/notify';
import { BarButton, SettingsCard, SettingsRow, Toggle } from './settings-ui';
import { useTelegramSettings, useUpdateTelegram } from './telegram-api';

const kinds: IncidentKind[] = ['node_down', 'node_blocked', 'server_down', 'cpu_high', 'mem_high'];
const events: TelegramEvent[] = ['incident_crit', 'incident_warn', 'resolved', 'reminder'];
export function IncidentTelegramCard() {
  const q = useTelegramSettings(),
    m = useUpdateTelegram();
  const [draft, setDraft] = useState<{
    kinds: Partial<Record<IncidentKind, boolean>>;
    events: Partial<Record<TelegramEvent, boolean>>;
  } | null>(null);
  const data = q.data;
  const pick = useCallback(
    () =>
      data
        ? {
            kinds: Object.fromEntries(kinds.map((k) => [k, data.kinds[k]])),
            events: Object.fromEntries(events.map((k) => [k, data.events[k]])),
          }
        : null,
    [data],
  );
  useEffect(() => setDraft(pick()), [pick]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(pick());
  async function save() {
    if (!draft) return;
    try {
      await m.mutateAsync(draft);
      toast.success('Уведомления об событиях сохранены.');
    } catch (e) {
      toast.error(apiErrorMessage(e));
    }
  }
  return (
    <SettingsCard
      title="События в Telegram"
      hint="Выключенный вид остаётся в панели, но не отправляется в Telegram. Чаты, тихие часы и частота напоминаний — в разделе «Уведомления»."
      footer={
        <BarButton disabled={!draft || !dirty || m.isPending} onClick={() => void save()}>
          {m.isPending ? 'Сохраняю…' : 'Сохранить уведомления'}
        </BarButton>
      }
    >
      {q.isError && (
        <p role="alert" className="py-3 text-crit">
          {apiErrorMessage(q.error)}
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
