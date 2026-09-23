import { BRAND_NAME_DEFAULT, brandNameSchema, logoUrlSchema } from '@nodeservice/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useAppearance, useUpdateAppearance } from './settings-api';
import { SettingsCard } from './settings-ui';

/**
 * Логотип и название панели — один блок с одной кнопкой «Сохранить».
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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
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
    <SettingsCard
      className="flex h-full flex-col"
      title="Логотип и название"
      hint="Так панель выглядит в шапке и на экране входа. Иконка вкладки браузера всегда стандартная."
    >
      <form onSubmit={submit} className="mt-3 flex flex-1 flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="brand-logo" className="text-[11.5px] font-medium text-text-2">
            Ссылка на логотип
          </label>
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
            className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
          />
          <p className="text-[11.5px] text-text-3">
            Прямая ссылка на PNG или SVG, лучше квадратную картинку.
          </p>
          {errors.logo && (
            <p role="alert" className="text-[12px] text-crit">
              {errors.logo}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="brand-name" className="text-[11.5px] font-medium text-text-2">
            Название
          </label>
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
            className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
          />
          <p className="text-[11.5px] text-text-3">
            Код цвета в квадратных скобках красит всё до следующего кода:{' '}
            <span className="font-mono">[#ff6b6b]Node[#accent]Service</span>. Коды —{' '}
            <span className="font-mono">[#rrggbb]</span>, <span className="font-mono">[#rgb]</span> или{' '}
            <span className="font-mono">[#accent]</span> (цвет акцента темы). Пробелы сохраняются.
          </p>
          {errors.name && (
            <p role="alert" className="text-[12px] text-crit">
              {errors.name}
            </p>
          )}
        </div>

        {errors.form && (
          <p role="alert" className="text-[12px] text-crit">
            {errors.form}
          </p>
        )}

        <div className="mt-auto flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={!dirty || update.isPending}
            className="rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover) disabled:opacity-50"
          >
            {update.isPending ? 'Сохраняю…' : 'Сохранить'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={isDefault || update.isPending}
            onClick={() => void reset()}
            className="rounded-[10px] border-border bg-surface-2 text-text-2 hover:bg-surface-3 hover:text-foreground"
          >
            Вернуть стандартные
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}
