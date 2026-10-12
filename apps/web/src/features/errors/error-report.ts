import { SHARED_VERSION } from '@nodeservice/shared';

import { isApiError } from '@/lib/api';

export interface ErrorExplanation {
  /** Заголовок для человека. */
  title: string;
  /** Что случилось и что делать — без жаргона. */
  advice: string;
  /** Категория для отчёта. */
  kind: 'network' | 'server' | 'auth' | 'client' | 'unknown';
}

/**
 * Переводит исключение в понятное объяснение. Самые частые случаи:
 * сеть/сервер (ApiError), ошибка в коде интерфейса (ReferenceError/TypeError — обычно сразу после
 * обновления панели, лечится перезагрузкой), остальное — «неизвестно», но с отчётом.
 */
export function explainError(error: unknown): ErrorExplanation {
  if (isApiError(error)) {
    if (error.status === 0)
      return {
        kind: 'network',
        title: 'Нет связи с сервером',
        advice:
          'Панель не смогла связаться со своим сервером. Проверьте сеть и что панель запущена, затем обновите страницу.',
      };
    if (error.status === 401)
      return {
        kind: 'auth',
        title: 'Сессия закончилась',
        advice: 'Нужно войти заново — данные не потеряны.',
      };
    if (error.status >= 500)
      return {
        kind: 'server',
        title: 'Сервер ответил ошибкой',
        advice: `Сервер панели вернул код ${error.status}. Попробуйте ещё раз; если повторяется — отправьте отчёт ниже, в нём есть номер запроса.`,
      };
    return {
      kind: 'server',
      title: error.title || 'Ошибка запроса',
      advice: error.detail ?? 'Сервер отклонил запрос. Попробуйте ещё раз или отправьте отчёт.',
    };
  }
  if (error instanceof Error && error.name === 'CancelledError')
    return {
      kind: 'network',
      title: 'Запрос прервался',
      advice: 'Обычно из-за быстрого перехода между страницами. Обновите страницу — данные не потеряны.',
    };
  if (error instanceof ReferenceError || error instanceof TypeError || error instanceof SyntaxError)
    return {
      kind: 'client',
      title: 'Ошибка в коде интерфейса',
      advice:
        'Страница не смогла отрисоваться. Чаще всего это бывает сразу после обновления панели — обновите страницу. Если повторяется, скопируйте отчёт и отправьте разработчику: в нём есть всё, чтобы найти причину.',
    };
  return {
    kind: 'unknown',
    title: 'Что-то сломалось',
    advice: 'Обновите страницу. Если повторяется — скопируйте отчёт и отправьте разработчику.',
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/** Текстовый отчёт для отправки: всё, что нужно, чтобы воспроизвести и починить. Секретов здесь нет. */
export function buildErrorReport(
  error: unknown,
  extra: { path: string; theme?: string | undefined },
): string {
  const explanation = explainError(error);
  const lines = [
    '=== NodeService: отчёт об ошибке ===',
    `Время: ${new Date().toISOString()}`,
    `Панель: ${SHARED_VERSION}`,
    `Страница: ${extra.path}`,
    `Тип: ${explanation.kind} — ${explanation.title}`,
    `Сообщение: ${errorMessage(error)}`,
  ];
  if (isApiError(error)) {
    lines.push(`HTTP: ${error.status} ${error.type}`);
    if (error.requestId) lines.push(`Запрос: ${error.requestId}`);
    if (error.errors.length)
      lines.push(`Поля: ${error.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  }
  if (typeof navigator !== 'undefined') lines.push(`Браузер: ${navigator.userAgent}`);
  if (extra.theme) lines.push(`Тема: ${extra.theme}`);
  if (error instanceof Error && error.stack) lines.push('', 'Стек:', error.stack);
  return lines.join('\n');
}
