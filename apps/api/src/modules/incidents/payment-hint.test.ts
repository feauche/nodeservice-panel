import { describe, expect, it } from 'vitest';

import {
  NO_PAYMENT_FACTS,
  ONLINE_DROP_PAYMENT_TITLE,
  type PaymentFacts,
  type PaymentPicture,
  paymentConclusion,
  paymentLines,
  paymentTitled,
  rentalGuess,
  serverDownLabel,
} from './payment-hint.js';

const RENT_SOON = 'Аренда «Guardora»: 2 500 ₽, оплачено до 30 сентября, 16:00 (UTC+6)';
const RENT_LATE = 'Аренда «Guardora»: 2 500 ₽, оплачено до 29 сентября, 00:00 (UTC+6)';
const SERVER_SOON = 'Сервер «DE-1» у Hetzner: €4.51, оплачено до 30 сентября, 22:56 (UTC+6)';
const CERT_LATE = 'Сертификат «certwarden»: 900 ₽, оплачено до 29 сентября, 12:00 (UTC+6)';

const facts = (over: Partial<PaymentFacts>): PaymentFacts => ({
  overdue: [],
  dueSoon: [],
  paying: 1,
  ...over,
});
const soon = facts({ dueSoon: [{ kind: 'rent', text: RENT_SOON }] });
const late = facts({ overdue: [{ kind: 'rent', text: RENT_LATE }] });
const hosting = facts({ dueSoon: [{ kind: 'server', text: SERVER_SOON }] });

const ALL: PaymentPicture[] = [
  'down',
  'entry',
  'nothing',
  'unchecked',
  'unchecked-alive',
  'ru-only',
  'panel-only',
  'port-only',
  'entry-unchecked',
  'bridge-unchecked',
  'partial',
  'stalled',
  'fleet',
  'fleet-dark',
  'fleet-down',
];
/** Картины с другим объяснением: оплата в заголовок дела не идёт, а в тексте стоит «заодно». */
const UNTITLED: PaymentPicture[] = [
  'partial',
  'stalled',
  'fleet',
  'fleet-dark',
  'fleet-down',
  // Свой мост не проверен: арендодатель его не выключит — начинать надо с моста.
  'bridge-unchecked',
];
/** Картины, где панель проверила не всё: причиной оплату не называет, просит проверить. */
const SOFT = ALL.filter((p) => !['down', 'entry', 'nothing'].includes(p) && !UNTITLED.includes(p));

describe('подсказка об оплате в тексте инцидента', () => {
  it('оплаты в окне нет — ни строк, ни вывода, ни своей подписи', () => {
    for (const picture of ALL) {
      expect(paymentLines(NO_PAYMENT_FACTS, picture)).toEqual([]);
      expect(paymentConclusion(NO_PAYMENT_FACTS, picture)).toBeNull();
    }
    expect(serverDownLabel(NO_PAYMENT_FACTS)).toBeUndefined();
  });

  it('факты — строками с подписью: просрочка и близкий срок называются по-разному', () => {
    expect(paymentLines(late, 'down')).toEqual([`💳 Просрочена оплата: ${RENT_LATE}.`]);
    expect(paymentLines(soon, 'down')).toEqual([`💳 Срок оплаты близко: ${RENT_SOON}.`]);
    expect(
      paymentLines(facts({ overdue: late.overdue, dueSoon: soon.dueSoon, paying: 2 }), 'down'),
    ).toHaveLength(2);
  });

  it('срок близко, сервер недоступен целиком — «отключили чуть раньше срока», и что сделать', () => {
    expect(paymentConclusion(soon, 'down')).toBe(
      'Вероятнее всего: оплата закончилась чуть раньше срока, и сервер отключили — проверьте баланс у провайдера или арендодателя, после оплаты отметьте продление в «Биллинге».',
    );
    expect(paymentConclusion(late, 'down')).toBe(
      'Вероятнее всего: отключили за неоплату — продлите у провайдера или арендодателя и отметьте продление в «Биллинге».',
    );
  });

  it('выход работает, вход арендодателя молчит — так выглядит неоплаченная аренда', () => {
    expect(paymentConclusion(soon, 'entry')).toBe(
      'Вероятнее всего: оплата закончилась чуть раньше срока, и вход отключили — при неоплаченной аренде вход выключают, а выход продолжает работать. Проверьте оплату у арендодателя, после оплаты отметьте продление в «Биллинге».',
    );
    expect(paymentConclusion(late, 'entry')).toContain('вход отключили за неоплату');
  });

  it('сервер отвечает и больше ничего не нашлось — всё равно вероятнее всего оплата (решение владельца)', () => {
    expect(paymentConclusion(soon, 'nothing')).toBe(
      'Вероятнее всего: оплата закончилась чуть раньше срока — другой причины панель не нашла. Проверьте баланс у арендодателя, после оплаты отметьте продление в «Биллинге».',
    );
    expect(paymentConclusion(late, 'nothing')).toContain(
      'доступ закрыли за неоплату — другой причины панель не нашла',
    );
  });

  it('вид оплаты решает: хостинг работающего сервера не объясняет ни молчащий вход, ни падение онлайна', () => {
    // Сервер отвечает — значит, хостер его не отключал: оплата хостинга тут ни при чём.
    for (const picture of [
      'entry',
      'nothing',
      'port-only',
      'entry-unchecked',
      'bridge-unchecked',
      'partial',
      'stalled',
      'fleet',
      // Проверить не удалось, но агент на связи: сервер работает.
      'unchecked-alive',
    ] as const) {
      expect(paymentConclusion(hosting, picture), picture).toBeNull();
      expect(paymentLines(hosting, picture), picture).toEqual([]);
    }
    // Сервер не отвечает или не проверен — оплата хостинга объясняет.
    expect(paymentConclusion(hosting, 'down')).toContain('сервер отключили');
    expect(serverDownLabel(hosting)).toBe('Сервер недоступен — проверьте оплату');
    for (const picture of ['unchecked', 'ru-only', 'panel-only', 'fleet-dark', 'fleet-down'] as const)
      expect(paymentConclusion(hosting, picture), picture).toMatch(/^(Проверьте|Заодно проверьте) оплату: /);
  });

  it('сертификат, домен и «Другое» сервер не выключают — в вывод не идут никогда', () => {
    for (const kind of ['cert', 'domain', 'other'] as const) {
      const p = facts({ overdue: [{ kind, text: CERT_LATE }], dueSoon: [{ kind, text: CERT_LATE }] });
      for (const picture of ALL) {
        expect(paymentConclusion(p, picture), `${kind}/${picture}`).toBeNull();
        expect(paymentLines(p, picture), `${kind}/${picture}`).toEqual([]);
      }
      expect(serverDownLabel(p)).toBeUndefined();
    }
    // Рядом с арендой сертификат в строки тоже не попадает.
    const mixed = facts({ overdue: [{ kind: 'cert', text: CERT_LATE }], dueSoon: soon.dueSoon, paying: 1 });
    expect(paymentLines(mixed, 'down')).toEqual([`💳 Срок оплаты близко: ${RENT_SOON}.`]);
    expect(paymentConclusion(mixed, 'down')).toContain('чуть раньше срока');
  });

  it('проверка неполная — без «вероятнее всего»: только просьба проверить оплату и почему панель не уверена', () => {
    expect(paymentConclusion(soon, 'unchecked')).toBe(
      'Проверьте оплату: встречная проверка не удалась, а срок оплаты близко — возможно, оплата закончилась чуть раньше срока.',
    );
    expect(paymentConclusion(late, 'unchecked')).toContain('а оплата просрочена');
    // Из России порт молчит, из-за рубежа порт не проверен (нечем или не удалось): блокировку IP от
    // отключения не отличить.
    expect(paymentConclusion(soon, 'ru-only')).toBe(
      'Проверьте оплату: из-за рубежа порт не проверен, а срок оплаты близко — возможно, сервер отключили чуть раньше срока.',
    );
    // Сервер не отвечает панели, а из других стран порт не проверен.
    expect(paymentConclusion(soon, 'panel-only')).toBe(
      'Проверьте оплату: из других стран порт не проверен, а срок оплаты близко — возможно, сервер отключили чуть раньше срока.',
    );
    // Имя маскировки неизвестно: порт отвечает, но блокировку панель проверить не может.
    expect(paymentConclusion(soon, 'port-only')).toBe(
      'Проверьте оплату: порт отвечает, но блокировку панель проверить не может, а срок оплаты близко — возможно, оплата закончилась чуть раньше срока.',
    );
    // Свой мост проверить не удалось — оплата аренды не первая причина: начинать с моста.
    expect(paymentConclusion(soon, 'bridge-unchecked')).toBe(
      'Заодно проверьте оплату: срок аренды близко. Сервер отвечает, а свой мост проверить не удалось — начните с моста: арендодатель его выключить не может.',
    );
    // Вход арендодателя проверить не удалось — возможная причина не проверена.
    expect(paymentConclusion(soon, 'entry-unchecked')).toBe(
      'Проверьте оплату: вход арендодателя проверить не удалось, а срок оплаты аренды близко — возможно, оплата закончилась чуть раньше срока.',
    );
    for (const picture of SOFT)
      for (const p of [soon, late]) {
        expect(paymentConclusion(p, picture), picture).toMatch(/^Проверьте оплату: /);
        expect(paymentConclusion(p, picture), picture).not.toContain('Вероятнее всего');
        expect(paymentConclusion(p, picture), picture).not.toContain('другой причины панель не нашла');
      }
  });

  it('у панели уже есть другое объяснение — оплата идёт «заодно», и сказано, что у панели на первом месте', () => {
    // Онлайн упал сразу у нескольких нод — общая причина вероятнее оплаты одной из них.
    expect(paymentConclusion(soon, 'fleet')).toBe(
      'Заодно проверьте оплату: срок аренды близко. Онлайн упал сразу у нескольких нод — это больше похоже на общую причину.',
    );
    // Этот сервер при этом не отвечает: общей причиной может быть и общий счёт у хостера.
    expect(paymentConclusion(soon, 'fleet-dark')).toBe(
      'Заодно проверьте оплату: срок оплаты этого сервера близко. Онлайн упал сразу у нескольких нод — это больше похоже на общую причину; если они у одного хостера, ею может быть и оплата.',
    );
    expect(paymentConclusion(late, 'fleet-down')).toBe(
      'Заодно проверьте оплату: оплата этого сервера просрочена. Связь пропала сразу с несколькими серверами — это больше похоже на общую причину; если они у одного хостера, ею может быть и оплата.',
    );
    // Панель называет то, что видела у других: упавший онлайн или пропавшую связь — не одно вместо другого.
    expect(paymentConclusion(soon, 'fleet', 'link')).toBe(
      'Заодно проверьте оплату: срок аренды близко. В это же время пропала связь с другими серверами — это больше похоже на общую причину.',
    );
    expect(paymentConclusion(soon, 'fleet-dark', 'link')).toBe(
      'Заодно проверьте оплату: срок оплаты этого сервера близко. В это же время пропала связь с другими серверами — это больше похоже на общую причину; если они у одного хостера, ею может быть и оплата.',
    );
    expect(paymentConclusion(late, 'fleet-down', 'online')).toBe(
      'Заодно проверьте оплату: оплата этого сервера просрочена. В это же время упал онлайн у других нод — это больше похоже на общую причину; если они у одного хостера, ею может быть и оплата.',
    );
    // Остальным картинам «что у других» безразлично.
    expect(paymentConclusion(soon, 'partial', 'link')).toBe(paymentConclusion(soon, 'partial'));
    // Порт отвечает с перебоями.
    expect(paymentConclusion(soon, 'partial')).toBe(
      'Заодно проверьте оплату: срок аренды близко. Порт отвечает с перебоями — это больше похоже на сбой маршрута или блокировку у части провайдеров, чем на неоплату.',
    );
    // Соединение обрывается на небольшом объёме данных.
    expect(paymentConclusion(late, 'stalled')).toBe(
      'Заодно проверьте оплату: аренда просрочена. Соединение с нодой обрывается на небольшом объёме данных — это больше похоже на помехи на пути, чем на неоплату.',
    );
    for (const picture of UNTITLED)
      for (const p of [soon, late]) {
        expect(paymentConclusion(p, picture), picture).toMatch(/^Заодно проверьте оплату: /);
        expect(paymentConclusion(p, picture), picture).not.toContain('Вероятнее всего');
      }
  });

  it('просрочка важнее близкого срока, если есть обе', () => {
    const both = facts({ overdue: late.overdue, dueSoon: soon.dueSoon, paying: 2 });
    expect(paymentConclusion(both, 'down')).toContain('отключили за неоплату');
    expect(serverDownLabel(both)).toBe('Сервер недоступен — просрочена оплата');
  });

  it('подписи дел; когда у панели есть другое объяснение, оплата в заголовок не ставится', () => {
    expect(serverDownLabel(late)).toBe('Сервер недоступен — просрочена оплата');
    expect(serverDownLabel(soon)).toBe('Сервер недоступен — проверьте оплату');
    expect(serverDownLabel(late, 'panel-only')).toBe('Сервер недоступен — просрочена оплата');
    // Сбой сразу у нескольких серверов — подпись дела обычная.
    expect(serverDownLabel(late, 'fleet-down')).toBeUndefined();
    expect(serverDownLabel(soon, 'fleet-dark')).toBeUndefined();
    expect(ONLINE_DROP_PAYMENT_TITLE).toBe('Резко упал онлайн — проверьте оплату');
    for (const picture of ALL)
      expect(paymentTitled(soon, picture), picture).toBe(!UNTITLED.includes(picture));
    expect(paymentTitled(NO_PAYMENT_FACTS, 'down')).toBe(false);
    expect(paymentTitled(hosting, 'nothing')).toBe(false);
  });

  it('вывод — одна строка с подписью до двоеточия: в Telegram подпись выделяется жирным', () => {
    for (const p of [soon, late])
      for (const picture of ALL) {
        const t = paymentConclusion(p, picture) ?? '';
        expect(t).toMatch(/^(Вероятнее всего|Проверьте оплату|Заодно проверьте оплату): /);
        expect(t).not.toContain('\n');
        expect(t.endsWith('.')).toBe(true);
      }
  });

  it('догадка «сервер арендован»: панель говорит только то, что знает о «Биллинге»', () => {
    // «Биллинг» не спрашивали (ноды нет среди серверов) или он не ответил.
    expect(rentalGuess(null)).toBe(
      'Сервер арендован: если он недоступен целиком, возможно, не оплачена аренда (оплату в «Биллинге» панель проверить не смогла).',
    );
    // Оплаты самого сервера (хостинг, аренда) нет — срок панель не знает, даже если привязан сертификат.
    expect(rentalGuess(NO_PAYMENT_FACTS)).toBe(
      'Сервер арендован: если он недоступен целиком, возможно, не оплачена аренда (оплата этого сервера в «Биллинге» не заведена — срока панель не знает).',
    );
    // Оплата заведена и срок не близко — неоплату не предлагаем.
    expect(rentalGuess(facts({ paying: 2 }))).toBeNull();
  });
});
