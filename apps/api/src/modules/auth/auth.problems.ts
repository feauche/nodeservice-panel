import { HttpStatus } from '@nestjs/common';
import { AUTH_PROBLEM } from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';

/** Ошибки auth в формате problem+json. Тексты одинаковы для «нет логина» и «не тот пароль». */
export const authProblems = {
  invalidCredentials: () =>
    problem(HttpStatus.UNAUTHORIZED, {
      type: AUTH_PROBLEM.invalidCredentials,
      detail: 'Неверный логин или пароль.',
    }),
  throttled: (retryAfterSeconds: number) =>
    problem(HttpStatus.TOO_MANY_REQUESTS, {
      type: AUTH_PROBLEM.throttled,
      detail: `Слишком много неудачных попыток. Подождите ${formatSeconds(retryAfterSeconds)} и попробуйте снова.`,
      extensions: { retryAfterSeconds },
      headers: { 'Retry-After': String(retryAfterSeconds) },
    }),
  /**
   * Суточный лимит неверных кодов исчерпан: код из приложения не принимается до конца окна.
   * rememberedWorks — запомненные устройства входят без кода (политика «всегда спрашивать код» выключена):
   * обещаем только тот путь входа, который сейчас действительно открыт.
   */
  codeEntryClosed: (retryAfterSeconds: number, rememberedWorks: boolean) =>
    problem(HttpStatus.TOO_MANY_REQUESTS, {
      type: AUTH_PROBLEM.codeEntryClosed,
      detail: `За сутки слишком много неверных кодов. Вход по коду из приложения закрыт ещё на ${formatWait(retryAfterSeconds)}. ${rememberedWorks ? 'Войдите с запомненного устройства или по коду восстановления.' : 'Войдите по коду восстановления.'}`,
      extensions: { retryAfterSeconds },
      headers: { 'Retry-After': String(retryAfterSeconds) },
    }),
  /** Все попытки заняты другими запросами или очередь проверок пароля полна — это не неудача входа. */
  busy: () =>
    problem(HttpStatus.TOO_MANY_REQUESTS, {
      type: AUTH_PROBLEM.busy,
      detail:
        'Сейчас слишком много попыток входа одновременно. Подождите несколько секунд и попробуйте снова.',
      extensions: { retryAfterSeconds: BUSY_RETRY_SECONDS },
      headers: { 'Retry-After': String(BUSY_RETRY_SECONDS) },
    }),
  totpRequired: () =>
    problem(HttpStatus.UNAUTHORIZED, {
      type: AUTH_PROBLEM.totpRequired,
      detail: 'Сначала введите логин и пароль — шаг с кодом истёк или не начат.',
    }),
  invalidTotp: () =>
    problem(HttpStatus.UNAUTHORIZED, {
      type: AUTH_PROBLEM.invalidTotp,
      detail: 'Код не подошёл. Проверьте время на телефоне и введите новый код.',
    }),
  invalidRecovery: () =>
    problem(HttpStatus.UNAUTHORIZED, {
      type: AUTH_PROBLEM.invalidRecovery,
      detail: 'Такого кода восстановления нет или он уже использован.',
    }),
  setupDone: () =>
    problem(HttpStatus.CONFLICT, {
      type: AUTH_PROBLEM.setupDone,
      detail: 'Первый запуск уже выполнен — администратор создан. Просто войдите.',
    }),
  setupToken: () =>
    problem(HttpStatus.UNAUTHORIZED, {
      type: AUTH_PROBLEM.setupToken,
      detail:
        'Токен первого запуска не подходит. Возьмите актуальный из вывода установщика или команды «nodeservice cli setup-token».',
    }),
  stepUp: () =>
    problem(HttpStatus.FORBIDDEN, {
      type: AUTH_PROBLEM.stepUp,
      detail: 'Для этого действия введите пароль ещё раз.',
    }),
  locked: () =>
    problem(HttpStatus.FORBIDDEN, {
      type: AUTH_PROBLEM.locked,
      detail: 'Экран заблокирован — введите пароль.',
    }),
  unauthenticated: () =>
    problem(HttpStatus.UNAUTHORIZED, {
      type: AUTH_PROBLEM.unauthenticated,
      detail: 'Сессия не найдена или истекла. Войдите снова.',
    }),
} as const;

/** Через сколько секунд повторить, когда попытки просто столкнулись по времени. */
const BUSY_RETRY_SECONDS = 3;

function formatSeconds(s: number): string {
  if (s < 60) return `${s} с`;
  const m = Math.ceil(s / 60);
  return `${m} мин`;
}

/** «30 с», «5 мин», «23 ч 40 мин» — сколько ждать, для текстов ошибок, уведомлений и Журнала. */
export function formatWait(seconds: number): string {
  if (seconds < 3600) return formatSeconds(seconds);
  const minutes = Math.ceil(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} ч ${m} мин` : `${h} ч`;
}
