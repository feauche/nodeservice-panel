import { HttpStatus } from '@nestjs/common';
import { SERVER_PROBLEM } from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';

export const serverProblems = {
  sshUnreachable: (host: string, detail?: string) =>
    problem(HttpStatus.BAD_GATEWAY, {
      type: SERVER_PROBLEM.sshUnreachable,
      detail: `Не удалось подключиться к ${host} по SSH${detail ? ` (${detail})` : ''}. Проверьте адрес, порт и firewall.`,
    }),
  sshAuth: (detail = 'Пароль или ключ не подошли.') =>
    problem(HttpStatus.BAD_REQUEST, { type: SERVER_PROBLEM.sshAuth, detail }),
  hostKeyMismatch: (expected: string, offered: string) =>
    problem(HttpStatus.CONFLICT, {
      type: SERVER_PROBLEM.hostKeyMismatch,
      detail:
        'Отпечаток сервера изменился. Так бывает после переустановки системы — или если кто-то подменяет сервер. Сравни отпечатки и довериь новый только если переустановка была твоей.',
      extensions: { expectedFingerprint: expected, offeredFingerprint: offered },
    }),
  sshCommand: (command: string, detail: string) =>
    problem(HttpStatus.BAD_GATEWAY, {
      type: SERVER_PROBLEM.sshCommand,
      detail: `Команда на сервере не выполнилась (${command}): ${detail}`,
    }),
  nameTaken: (name: string) =>
    problem(HttpStatus.CONFLICT, {
      type: SERVER_PROBLEM.nameTaken,
      detail: `Сервер с названием «${name}» уже есть.`,
      errors: [{ path: 'name', message: 'Название уже занято' }],
    }),
  passwordNeedsVerify: () =>
    problem(HttpStatus.BAD_REQUEST, {
      detail:
        'С паролем сервер добавляется только с подключением: пароль не хранится, он нужен один раз — чтобы поставить ключ панели. Выбери «Свой ключ» или «Ключ панели», если хочешь добавить без проверки.',
      errors: [{ path: 'password', message: 'С паролем подключение обязательно' }],
    }),
  notFound: () => problem(HttpStatus.NOT_FOUND, { detail: 'Сервер не найден — возможно, уже удалён.' }),
};
