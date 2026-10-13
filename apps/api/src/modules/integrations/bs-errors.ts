/**
 * Ошибки BS Checker (bsbord.com/v1, контракт 1.1 от 12.10.2026) по коду из конверта
 * {"error":{"code","message","details"}}: английский message сервис может менять, код — нет.
 */
const BS_ERRORS: Record<string, string> = {
  unauthenticated: 'Ключ BS Checker неверный или отозван. Обновите его в «Подключении».',
  api_not_available: 'У ключа BS Checker нет доступа к API.',
  tier_too_low: 'API BS Checker доступен с тарифа Bronze.',
  subscription_required: 'BS Checker просит подписаться на его канал.',
  scope_required:
    'Ключу нужно право «Может менять адреса точек аренды» — создайте ключ с этой галочкой в кабинете BS Checker и обновите его в «Подключении».',
  insufficient_credits: 'Не хватает кредитов на балансе BS Checker.',
  unknown_operator: 'Список точек устарел. Обновите страницу и выберите точки заново.',
  invalid_request: 'BS Checker не принял запрос. Проверьте введённые данные.',
  request_denied: 'BS Checker отказал в проверке.',
  no_probes: 'Выберите TCP или ICMP.',
  no_dpi_on: 'Выбранные точки сейчас в другом режиме белого списка. Обновите список и выберите точки заново.',
  too_many_targets: 'Слишком много целей за раз — не больше 10.',
  blocked_target: 'BS Checker не проверяет этот адрес: он в его блок-листе.',
  idempotency_key_required: 'BS Checker не принял запуск без номера запроса. Рассчитайте стоимость заново.',
  idempotency_key_reused: 'Этот запуск уже был с другими данными. Рассчитайте стоимость заново.',
  request_in_progress:
    'Проверка ещё идёт. Подождите и получите результат той же кнопкой — второго списания не будет.',
  rate_limited: 'Слишком часто: BS Checker принимает не чаще раза в секунду.',
  daily_limit: 'Лимит изменений на сегодня исчерпан — не больше 48 в сутки на точку.',
  slow_down: 'Слишком часто — подождите несколько секунд.',
  busy: 'Точка сейчас занята другим действием. Повторите через минуту.',
  too_many_active: 'Уже идут другие проверки аккаунта. Повторите через минуту.',
  scan_in_progress: 'У аккаунта уже идёт скан подсети. Повторите после него.',
  test_in_progress: 'У аккаунта уже идёт тест подключения. Повторите после него.',
  maintenance: 'BS Checker на обслуживании. Повторите позже.',
  bot_not_ready: 'BS Checker запускается. Повторите через минуту.',
  worker_unavailable: 'Сейчас нет подходящих точек проверки. Повторите позже.',
  scanner_unavailable: 'Проверка временно недоступна. Повторите позже.',
  lte_unavailable: 'Каналы операторов отвалились по ходу проверки. Повторите позже.',
  no_alive_modems: 'Сейчас нет живых точек проверки. Повторите позже.',
  internal_error: 'Внутренняя ошибка BS Checker.',
  // Аренда точек входа (/v1/rentals)
  rental_not_found: 'Точка аренды не найдена.',
  no_access: 'Доступ к этой точке для ключа закрыт.',
  rental_expired: 'Срок аренды истёк.',
  targets_check_timeout: 'BS Checker не успел проверить адреса за 35 секунд — ничего не изменено. Повторите.',
  node_offline: 'Сервер точки сейчас не на связи — изменение не применено.',
  not_active: 'Точка не активна.',
  not_supported: 'Эта точка такое изменение не поддерживает.',
  forbidden_network: 'Этот адрес нельзя указать выходом: запрещённая сеть.',
  self_target: 'Нельзя направить точку саму на себя.',
  blocklist: 'Адрес в блок-листе BS Checker.',
  resolve_failed: 'Домен выхода не удалось разрешить в IP.',
  bad_port: 'Недопустимый порт выхода.',
  invalid_targets: 'Адреса выходов не приняты.',
  rent_unavailable: 'Аренда временно недоступна. Повторите позже.',
  // Точки входа WebSocket (/v1/ws)
  ws_not_found: 'Точка WebSocket не найдена.',
  invalid_exits: 'Серверы точки не приняты.',
  too_many_exits: 'Слишком много серверов — не больше 16.',
  ssh_port: 'Порт 22 нельзя указать сервером точки.',
  bad_weight: 'Вес сервера — от 1 до 100.',
  bad_max_connections: 'Лимит подключений — от 1 до 100 000.',
  no_primary: 'Нужен хотя бы один включённый основной сервер.',
  last_exit: 'Нельзя убрать последний сервер точки.',
  backup_sticky:
    'При закреплении клиентов за сервером запасные не используются — уберите их или выберите распределение по весу.',
  dup_exit: 'Серверы не должны повторяться.',
  bad_balancing: 'Неизвестный способ распределения.',
  bad_health_check: 'Неизвестный режим проверки серверов.',
  admin_paused: 'Точка приостановлена поддержкой BS Checker.',
  not_ready: 'Настройки точки ещё не готовы — подождите несколько минут.',
  ws_released: 'Точка освобождена.',
  gone: 'Точка удалена.',
  // Свои: сеть и разбор ответа
  connection_lost: 'BS Checker не ответил: связь оборвалась.',
  invalid_response: 'BS Checker прислал ответ, который панель не поняла.',
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/**
 * Текст ошибки для владельца. Ошибки адресов («Выход 2: …») берутся из details.errors, если сервис написал их
 * по-русски; «слишком часто» — с паузой из retry_after.
 */
export function bsErrorText(code: string, details: unknown = null, status = 0): string {
  const d = obj(details);
  const base =
    BS_ERRORS[code] ??
    (status === 401
      ? (BS_ERRORS.unauthenticated as string)
      : status === 402
        ? (BS_ERRORS.insufficient_credits as string)
        : status === 403
          ? 'BS Checker отклонил доступ. Проверьте ключ в «Подключении».'
          : status === 429
            ? (BS_ERRORS.rate_limited as string)
            : status >= 500
              ? 'BS Checker временно не работает. Повторите позже.'
              : `BS Checker не выполнил запрос (код ответа ${status || 'нет'}).`);
  const wait = Number(d.retry_after);
  const pause =
    Number.isFinite(wait) && wait > 0 && /часто|занята|идут|Повторите/.test(base)
      ? ` Подождите ${Math.ceil(wait)} с.`
      : '';
  const rows = Array.isArray(d.errors)
    ? d.errors
        .map(obj)
        .filter((e) => typeof e.message === 'string' && /[А-Яа-яЁё]/.test(e.message))
        .map(
          (e) =>
            `${Number.isInteger(e.index) ? `${code === 'invalid_exits' ? 'Сервер' : 'Выход'} ${Number(e.index) + 1}: ` : ''}${e.message}`,
        )
    : [];
  return [base + pause, ...rows].join(' ');
}
