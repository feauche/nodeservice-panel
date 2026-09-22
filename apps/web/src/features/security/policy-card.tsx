import { IDLE_MINUTES_OPTIONS, LOCK_AFTER_OPTIONS, type SecurityPolicy } from '@nodeservice/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsCard, SettingsRow, Toggle } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { useSecurityOverview, useUpdatePolicy } from './security-api';
import { plural } from './security-format';
import { StepUpCancelledError } from './step-up';

function minutesLabel(m: number): string {
  if (m === 0) return 'выключено';
  if (m >= 60 && m % 60 === 0) {
    const h = m / 60;
    return `${h} ${plural(h, ['час', 'часа', 'часов'])}`;
  }
  return `${m} ${plural(m, ['минута', 'минуты', 'минут'])}`;
}

function MinutesSelect({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: number;
  options: readonly number[];
  onChange: (v: number) => void;
}) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger id={id} className="h-9 min-w-[170px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={String(o)}>
            {minutesLabel(o)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Политика: idle-таймаут сессии, автоблокировка экрана, «всегда спрашивать код». Сохранение — за step-up. */
export function PolicyCard() {
  const overview = useSecurityOverview();
  const update = useUpdatePolicy();
  const saved = overview.data?.policy;
  const [draft, setDraft] = useState<SecurityPolicy | null>(null);
  useEffect(() => {
    if (saved) setDraft(saved);
  }, [saved]);

  const dirty =
    Boolean(saved && draft) &&
    (saved?.idleMinutes !== draft?.idleMinutes ||
      saved?.lockAfterMinutes !== draft?.lockAfterMinutes ||
      saved?.alwaysAskTotp !== draft?.alwaysAskTotp);

  const save = async () => {
    if (!draft) return;
    try {
      await update.mutateAsync(draft);
      toast.success('Политика безопасности сохранена.');
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) toast.error(apiErrorMessage(err));
    }
  };

  const d = draft ?? saved;
  return (
    <SettingsCard title="Политика" hint="Действует для всех сессий сразу после сохранения.">
      <div className="mt-1">
        <SettingsRow
          label="Завершать сессию при бездействии"
          hint="Без запросов к панели дольше этого времени — вход заново. SSH-терминал считается активностью."
        >
          {d && (
            <MinutesSelect
              id="policy-idle"
              value={d.idleMinutes}
              options={IDLE_MINUTES_OPTIONS}
              onChange={(v) => setDraft({ ...d, idleMinutes: v })}
            />
          )}
        </SettingsRow>
        <SettingsRow
          label="Блокировать экран при бездействии"
          hint="Только в этом браузере: экран блокировки, сессия и терминалы живут."
        >
          {d && (
            <MinutesSelect
              id="policy-lock"
              value={d.lockAfterMinutes}
              options={LOCK_AFTER_OPTIONS}
              onChange={(v) => setDraft({ ...d, lockAfterMinutes: v })}
            />
          )}
        </SettingsRow>
        <SettingsRow label="Всегда спрашивать код 2FA" hint="Запомненные устройства перестают действовать.">
          {d && (
            <Toggle
              id="policy-always-totp"
              checked={d.alwaysAskTotp}
              onChange={(v) => setDraft({ ...d, alwaysAskTotp: v })}
            />
          )}
        </SettingsRow>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button
          type="button"
          disabled={!dirty || update.isPending}
          onClick={() => void save()}
          className="rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover) disabled:opacity-50"
        >
          {update.isPending ? 'Сохраняю…' : 'Сохранить'}
        </Button>
        <span className="text-[11.5px] text-text-3">Спросим пароль ещё раз.</span>
      </div>
    </SettingsCard>
  );
}
