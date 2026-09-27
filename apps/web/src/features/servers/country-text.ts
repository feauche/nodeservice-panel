import { countryName, type ServerCountry } from '@nodeservice/shared';

import { formatAgo } from '@/features/security/security-format';

/** Что видно на карточке и в поле по состоянию страны сервера. */
export type CountryView = 'unset' | 'detecting' | 'auto' | 'manual' | 'failed';

/** Сведено к тому, что показывают поле «Страна» и плитка на карточке. */
export function countryView(c: ServerCountry): CountryView {
  if (c.source === 'manual' && c.code) return 'manual';
  if (c.status === 'detecting') return 'detecting';
  if (c.status === 'failed') return 'failed';
  if (c.code && c.status === 'ok') return 'auto';
  return c.code ? 'auto' : 'unset';
}

/** «6 из 7 источников» или пусто, если доли нет. */
export const agreeText = (c: ServerCountry): string | null =>
  c.agree !== null && c.total !== null ? `${c.agree} из ${c.total} источников` : null;

/** Подсказка к флагу на карточке: страна, откуда она взялась и когда проверена (без разметки). */
export function countryTip(c: ServerCountry): { name: string | null; text: string } {
  const view = countryView(c);
  const name = c.code ? countryName(c.code) : null;
  const when = c.checkedAt ? formatAgo(c.checkedAt) : null;
  switch (view) {
    case 'manual':
      return { name, text: 'Выбрана вручную.' };
    case 'detecting':
      return { name, text: 'Определяется по IP сервера…' };
    case 'failed':
      return name
        ? { name, text: `Последняя проверка не удалась${c.note ? `: ${c.note}` : '.'}` }
        : { name: null, text: 'Страну не удалось определить. Выберите вручную на вкладке «Подключение».' };
    case 'auto': {
      const agree = agreeText(c);
      return {
        name,
        text: `Определена автоматически${agree ? `: ${agree}` : ''}.${when ? ` Проверено ${when}.` : ''}`,
      };
    }
    default:
      return { name: null, text: 'Страна не задана.' };
  }
}
