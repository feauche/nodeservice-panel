import {
  AUTOCHECKS_DEFAULTS,
  type AutochecksSettings,
  autochecksSettingsUpdateSchema,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

/** Мок /api/settings/autochecks: состояние в памяти, PUT мёржит partial-обновление. */
export const mockAutochecks: { value: AutochecksSettings } = { value: { ...AUTOCHECKS_DEFAULTS } };

export function seedAutochecks(): void {
  mockAutochecks.value = { ...AUTOCHECKS_DEFAULTS };
}

export const autochecksHandlers = [
  http.get('/api/settings/autochecks', () => HttpResponse.json(mockAutochecks.value)),
  http.put('/api/settings/autochecks', async ({ request }) => {
    const parsed = autochecksSettingsUpdateSchema.safeParse(await request.json());
    if (!parsed.success)
      return HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Данные не прошли проверку',
          status: 400,
          detail: 'Проверьте поля',
          errors: parsed.error.issues.map((i) => ({ path: String(i.path[0]), message: i.message })),
        },
        { status: 400 },
      );
    const defined = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    mockAutochecks.value = { ...mockAutochecks.value, ...defined };
    return HttpResponse.json(mockAutochecks.value);
  }),
];
