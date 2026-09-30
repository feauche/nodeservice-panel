import {
  maskTelegramProxy,
  maskTelegramUrl,
  PANEL_TIME_ZONE_DEFAULT,
  parseTelegramUrl,
  TELEGRAM_DELIVERY_DEFAULT,
  TELEGRAM_EVENTS_DEFAULT,
  TELEGRAM_KINDS_DEFAULT,
  TELEGRAM_QUIET_DEFAULT,
  type TelegramSettings,
  type TelegramSettingsUpdate,
  type TelegramTestRequest,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

/** Мок настроек Telegram: токены «хранятся» тут же, наружу — только маска, как на сервере. */
export const mockTelegram = {
  settings: null as unknown as TelegramSettings,
  tokens: new Map<string, string>(),
  /** С каким значением «Расширенное оформление» пришёл последний тест; null — теста не было. */
  lastTestRich: null as boolean | null,
};

let seq = 0;

export function resetTelegram(): void {
  mockTelegram.tokens = new Map();
  mockTelegram.lastTestRich = null;
  mockTelegram.settings = {
    destinations: [],
    events: { ...TELEGRAM_EVENTS_DEFAULT },
    quiet: { ...TELEGRAM_QUIET_DEFAULT },
    kinds: { ...TELEGRAM_KINDS_DEFAULT },
    delivery: { ...TELEGRAM_DELIVERY_DEFAULT },
    proxy: null,
    // Как на сервере: тихие часы идут по поясу панели (его меняет мок «Внешнего вида»).
    timeZone: PANEL_TIME_ZONE_DEFAULT,
    timeZoneChosen: true,
  };
}
resetTelegram();

/** Чат -100999 «не найден» — чтобы в демо и тестах была видна ошибка Telegram. */
const verdict = (chatId: string) =>
  chatId === '-100999'
    ? { ok: false, detail: 'Чат не найден: добавьте бота в группу или проверьте id чата.' }
    : { ok: true, detail: 'Тест доставлен' };

export const telegramHandlers = [
  http.get('/api/settings/telegram', () => HttpResponse.json(mockTelegram.settings)),
  http.put('/api/settings/telegram', async ({ request }) => {
    const body = (await request.json()) as TelegramSettingsUpdate;
    const s = mockTelegram.settings;
    if (body.destinations) {
      const next: TelegramSettings['destinations'] = [];
      for (const d of body.destinations) {
        if ('id' in d) {
          const keep = s.destinations.find((x) => x.id === d.id);
          if (keep) next.push(keep);
          continue;
        }
        const t = parseTelegramUrl(d.url);
        if (!t)
          return HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Неверный запрос',
              status: 400,
              detail: 'Формат: tgram://токен_бота/id_чата:тема',
            },
            { status: 400, headers: { 'content-type': 'application/problem+json' } },
          );
        const id = `tg-${++seq}`;
        mockTelegram.tokens.set(id, t.token);
        next.push({
          id,
          masked: maskTelegramUrl(t.chatId, t.topic),
          chatId: t.chatId,
          topic: t.topic,
          botName: '@lumax_alert_bot',
          chatTitle: t.chatId.startsWith('-') ? 'VPN-алерты' : 'Личный чат',
          lastTest: null,
          // В «ненайденный» чат настоящие сообщения не доходят — в демо это видно отметкой у строки.
          lastDelivery:
            t.chatId === '-100999'
              ? { at: new Date(Date.now() - 2 * 3_600_000).toISOString(), ...verdict(t.chatId) }
              : null,
        });
      }
      s.destinations = next;
    }
    if (body.events) s.events = { ...s.events, ...(body.events as TelegramSettings['events']) };
    if (body.quiet) s.quiet = body.quiet;
    if (body.kinds) s.kinds = { ...s.kinds, ...(body.kinds as TelegramSettings['kinds']) };
    if (body.delivery) s.delivery = body.delivery;
    if (body.proxy !== undefined) s.proxy = body.proxy ? maskTelegramProxy(body.proxy) : null;
    return HttpResponse.json(s);
  }),
  http.post('/api/settings/telegram/test', async ({ request }) => {
    const body = (await request.json()) as TelegramTestRequest;
    const saved = body.id ? mockTelegram.settings.destinations.find((d) => d.id === body.id) : null;
    const chatId = saved?.chatId ?? parseTelegramUrl(body.url ?? '')?.chatId ?? '';
    const base = verdict(chatId);
    // Образец в расширенном оформлении мок «принимает» всегда — как свежий Telegram.
    const v =
      base.ok && body.rich
        ? {
            ...base,
            detail: 'Тест доставлен в расширенном оформлении — если в чате видна таблица, его можно включать',
          }
        : base;
    if (saved) saved.lastTest = { at: new Date().toISOString(), ...v };
    mockTelegram.lastTestRich = body.rich ?? null;
    return HttpResponse.json({
      ...v,
      botName: '@lumax_alert_bot',
      chatTitle: chatId.startsWith('-') ? 'VPN-алерты' : 'Личный чат',
    });
  }),
];
