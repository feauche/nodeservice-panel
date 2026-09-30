import { PANEL_TIME_ZONE_DEFAULT } from '@nodeservice/shared';
import { useMemo } from 'react';

import { Combobox } from '@/components/ui/combobox';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useAppearance, useUpdateAppearance } from './settings-api';
import { SettingsCard, SettingsRow } from './settings-ui';
import { browserTimeZone, timeZoneLabel, timeZoneOptions } from './time-zones';

/**
 * Часовой пояс панели (витрина `backups-variants.html`, вариант 1): для того, что сервер делает сам, —
 * сообщения в Telegram и их тихие часы, напоминания об оплате, расписание резервных копий. Сохраняется
 * сразу при выборе.
 */
export function TimeZoneCard() {
  const appearance = useAppearance();
  const update = useUpdateAppearance();
  const options = useMemo(() => timeZoneOptions(), []);
  const value = appearance.data?.timeZone ?? PANEL_TIME_ZONE_DEFAULT;
  const browser = browserTimeZone();

  const save = async (zone: string) => {
    if (zone === value) return;
    try {
      await update.mutateAsync({ timeZone: zone });
      toast.success(`Часовой пояс панели: ${timeZoneLabel(zone)}.`);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <SettingsCard
      title="Время"
      hint="Один пояс для того, что панель делает сама: время в сообщениях Telegram и тихие часы, время в тексте инцидентов и разборах Джарвиса, напоминания об оплате, расписание и список резервных копий. Остальные экраны показывают время по вашему браузеру."
    >
      <SettingsRow
        label="Часовой пояс панели"
        htmlFor="panel-tz"
        hint={
          browser && browser !== value ? (
            <>
              Ваш браузер: {timeZoneLabel(browser)} ·{' '}
              <button
                type="button"
                disabled={update.isPending}
                onClick={() => void save(browser)}
                className="cursor-pointer text-brand underline underline-offset-2 hover:no-underline disabled:opacity-50"
              >
                поставить
              </button>
            </>
          ) : (
            'Совпадает с часовым поясом вашего браузера.'
          )
        }
      >
        <Combobox
          id="panel-tz"
          ariaLabel="Часовой пояс панели"
          value={value}
          onChange={(v) => v && void save(v)}
          options={options}
          placeholder="Выберите пояс"
          searchPlaceholder="Город или пояс…"
          disabled={appearance.isLoading || update.isPending}
          className="w-[260px] max-sm:w-full"
        />
      </SettingsRow>
    </SettingsCard>
  );
}
