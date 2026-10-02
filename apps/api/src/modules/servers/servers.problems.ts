import { HttpStatus } from '@nestjs/common';
import { SERVER_PROBLEM } from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';

/** Коды цвета терминала (ESC[31m и подобные) — из вывода скриптов. */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

const sshUnavailableDetail = (host: string, detail?: string): string => {
  if (detail && /timed out while waiting for handshake/i.test(detail))
    return `Соединение с ${host} открылось, но SSH-сервер не завершил рукопожатие вовремя. Повторите попытку; если ошибка остаётся, проверьте нагрузку sshd, MaxStartups, fail2ban и firewall.`;
  return `Не удалось подключиться к ${host} по SSH${detail ? ` (${detail})` : ''}. Проверьте адрес, порт и firewall.`;
};

export const serverProblems = {
  sshUnreachable: (host: string, detail?: string) =>
    problem(HttpStatus.BAD_GATEWAY, {
      type: SERVER_PROBLEM.sshUnreachable,
      detail: sshUnavailableDetail(host, detail),
    }),
  sshAuth: (detail = 'Пароль или ключ не подошли.') =>
    problem(HttpStatus.BAD_REQUEST, { type: SERVER_PROBLEM.sshAuth, detail }),
  hostKeyMismatch: (expected: string, offered: string) =>
    problem(HttpStatus.CONFLICT, {
      type: SERVER_PROBLEM.hostKeyMismatch,
      detail:
        'Отпечаток сервера изменился. Так бывает после переустановки системы — или если кто-то подменяет сервер. Сравните отпечатки и доверяйте новому, только если переустановку делали вы.',
      extensions: { expectedFingerprint: expected, offeredFingerprint: offered },
    }),
  sshCommand: (command: string, detail: string) =>
    problem(HttpStatus.BAD_GATEWAY, {
      type: SERVER_PROBLEM.sshCommand,
      // Скрипты красят вывод (ESC[31m…) — в сообщении панели эти коды видны мусором.
      detail: `Команда на сервере не выполнилась (${command}): ${stripAnsi(detail).trim()}`,
    }),
  sudoRequired: (user: string, detail: string) =>
    problem(HttpStatus.BAD_GATEWAY, {
      type: SERVER_PROBLEM.sshCommand,
      detail: `Панель входит как «${user}», а для работы с сервером нужны права администратора. ${detail}`,
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
  providerNotFound: () =>
    problem(HttpStatus.UNPROCESSABLE_ENTITY, {
      detail: 'Такого провайдера нет в справочнике — возможно, его удалили.',
      errors: [{ path: 'providerId', message: 'Провайдер не найден' }],
    }),
};
