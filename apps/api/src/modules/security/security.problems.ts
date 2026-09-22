import { SECURITY_PROBLEM } from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';

export const securityProblems = {
  passwordPwned: () =>
    problem(400, {
      type: SECURITY_PROBLEM.passwordPwned,
      detail: 'Этот пароль встречается в известных утечках — выбери другой.',
      errors: [{ path: 'newPassword', message: 'Пароль есть в утечках — выбери другой' }],
    }),
  totpReissueExpired: () =>
    problem(400, {
      type: SECURITY_PROBLEM.totpReissueExpired,
      detail: 'Перевыпуск 2FA не начат или истёк — начни заново.',
    }),
  currentSession: () =>
    problem(400, {
      type: SECURITY_PROBLEM.currentSession,
      detail: 'Это текущая сессия — чтобы завершить её, нажми «Выйти».',
    }),
};
