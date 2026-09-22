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
      detail: `Слишком много неудачных попыток. Подожди ${formatSeconds(retryAfterSeconds)} и попробуй снова.`,
      extensions: { retryAfterSeconds },
      headers: { 'Retry-After': String(retryAfterSeconds) },
    }),
  totpRequired: () =>
    problem(HttpStatus.UNAUTHORIZED, {
      type: AUTH_PROBLEM.totpRequired,
      detail: 'Сначала введи логин и пароль — шаг с кодом истёк или не начат.',
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
      detail: 'Первый запуск уже выполнен — администратор создан. Просто войди.',
    }),
  setupToken: () =>
    problem(HttpStatus.UNAUTHORIZED, {
      type: AUTH_PROBLEM.setupToken,
      detail:
        'Токен первого запуска не подходит. Возьми актуальный из вывода установщика или `cli setup-token`.',
    }),
  stepUp: () =>
    problem(HttpStatus.FORBIDDEN, {
      type: AUTH_PROBLEM.stepUp,
      detail: 'Для этого действия введи пароль ещё раз.',
    }),
  locked: () =>
    problem(HttpStatus.FORBIDDEN, {
      type: AUTH_PROBLEM.locked,
      detail: 'Экран заблокирован — введи пароль.',
    }),
  unauthenticated: () =>
    problem(HttpStatus.UNAUTHORIZED, {
      type: AUTH_PROBLEM.unauthenticated,
      detail: 'Сессия не найдена или истекла. Войди снова.',
    }),
} as const;

function formatSeconds(s: number): string {
  if (s < 60) return `${s} с`;
  const m = Math.ceil(s / 60);
  return `${m} мин`;
}
