import { BRAND_NAME_DEFAULT, brandNameSchema, logoUrlSchema } from '@nodeservice/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useAppearance, useUpdateAppearance } from './settings-api';
import { BarButton, SaveBar, SettingsCard, SettingsRow } from './settings-ui';

/**
 * Логотип и название панели: карточка и общая для раздела панель «Сохранить» (единый стиль настроек).
 * Меняется только внутри панели (шапка, экран входа); иконка вкладки браузера остаётся стандартной.
 */
export function BrandCard() {
  const appearance = useAppearance();
  const update = useUpdateAppearance();
  const savedLogo = appearance.data?.logoUrl ?? null;
  const savedName = appearance.data?.brandName ?? BRAND_NAME_DEFAULT;

  const [logo, setLogo] = useState('');
  const [name, setName] = useState(BRAND_NAME_DEFAULT);
  const [errors, setErrors] = useState<{ logo?: string; name?: string; form?: string }>({});
  useEffect(() => {
    setLogo(savedLogo ?? '');
    setName(savedName);
  }, [savedLogo, savedName]);

  const logoTrim = logo.trim();
  const logoValue = logoTrim === '' ? null : logoTrim;
  const dirty = (savedLogo ?? '') !== logoTrim || savedName !== name;
  const isDefault = savedLogo === null && savedName === BRAND_NAME_DEFAULT;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const l = logoUrlSchema.safeParse(logoValue);
    const n = brandNameSchema.safeParse(name);
    if (!l.success || !n.success) {
      setErrors({
        ...(l.success ? {} : { logo: l.error.issues[0]?.message ?? 'Некорректная ссылка' }),
        ...(n.success ? {} : { name: n.error.issues[0]?.message ?? 'Некорректное название' }),
      });
      return;
    }
    setErrors({});
    try {
      await update.mutateAsync({ logoUrl: l.data, brandName: n.data });
      toast.success('Логотип и название сохранены.');
    } catch (err) {
      setErrors({ form: apiErrorMessage(err) });
    }
  };

  const reset = async () => {
    setErrors({});
    try {
      await update.mutateAsync({ logoUrl: null, brandName: BRAND_NAME_DEFAULT });
      toast.success('Вернул стандартный логотип и название.');
    } catch (err) {
      setErrors({ form: apiErrorMessage(err) });
    }
  };

  return (
    <>
      <SettingsCard
        title="Логотип и название"
        hint="Так панель выглядит в шапке и на экране входа. Иконка вкладки браузера всегда стандартная."
      >
        <form onSubmit={(e) => void submit(e)} id="brand-form">
          <SettingsRow
            stack
            label="Ссылка на логотип"
            htmlFor="brand-logo"
            hint={
              errors.logo ? (
                <span role="alert" className="text-crit">
                  {errors.logo}
                </span>
              ) : (
                'Прямая ссылка на PNG или SVG, лучше квадратную картинку.'
              )
            }
          >
            <Input
              id="brand-logo"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.com/logo.svg — пусто = стандартный"
              value={logo}
              onChange={(e) => {
                setLogo(e.target.value);
                setErrors((p) => ({ ...p, logo: undefined, form: undefined }));
              }}
              aria-invalid={errors.logo ? true : undefined}
              className="h-9 rounded-[9px] bg-surface-2 font-mono text-[13px]"
            />
          </SettingsRow>
          <SettingsRow
            stack
            label="Название"
            htmlFor="brand-name"
            hint={
              errors.name ? (
                <span role="alert" className="text-crit">
                  {errors.name}
                </span>
              ) : (
                <>
                  Код цвета в квадратных скобках красит всё до следующего кода:{' '}
                  <span className="font-mono">[#ff6b6b]Node[#accent]Service</span>. Коды —{' '}
                  <span className="font-mono">[#rrggbb]</span>, <span className="font-mono">[#rgb]</span> или{' '}
                  <span className="font-mono">[#accent]</span> (цвет акцента темы). Пробелы сохраняются.
                </>
              )
            }
          >
            <Input
              id="brand-name"
              autoComplete="off"
              spellCheck={false}
              placeholder={BRAND_NAME_DEFAULT}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setErrors((p) => ({ ...p, name: undefined, form: undefined }));
              }}
              aria-invalid={errors.name ? true : undefined}
              className="h-9 rounded-[9px] bg-surface-2 font-mono text-[13px]"
            />
          </SettingsRow>
        </form>
      </SettingsCard>
      <SaveBar
        dirty={dirty}
        pending={update.isPending}
        error={errors.form}
        onSave={() => void submit()}
        onReset={() => {
          setLogo(savedLogo ?? '');
          setName(savedName);
          setErrors({});
        }}
        note="Логотип и название — после сохранения, попадают в Журнал."
        extra={
          <BarButton disabled={isDefault || update.isPending} onClick={() => void reset()}>
            Вернуть стандартные
          </BarButton>
        }
      />
    </>
  );
}
