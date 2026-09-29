import { openAsBlob } from 'node:fs';
import { type Dispatcher, FormData, ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch } from 'undici';

/**
 * Тонкий клиент Bot API: один вызов метода, ответ в понятной форме. В тестах подменяется
 * (TELEGRAM_CLIENT), поэтому наружу ходит только настоящий.
 */
export type TelegramCall<T> = { ok: true; result: T } | { ok: false; status: number; description: string };

export interface TelegramClient {
  /** `proxy` — `socks5://…` или `http://…`; null — напрямую. */
  call<T>(
    token: string,
    method: string,
    body: Record<string, unknown>,
    proxy?: string | null,
  ): Promise<TelegramCall<T>>;
  /** Файл (sendDocument): поля формы и путь к файлу на диске. */
  sendFile<T>(
    token: string,
    fields: Record<string, string>,
    file: { path: string; name: string },
    proxy?: string | null,
  ): Promise<TelegramCall<T>>;
}
export const TELEGRAM_CLIENT = Symbol('TELEGRAM_CLIENT');

const TIMEOUT_MS = 15_000;

export class HttpTelegramClient implements TelegramClient {
  /** Агент на каждый прокси — переиспользуем соединения, а не открываем новое на каждое сообщение. */
  private readonly agents = new Map<string, Dispatcher>();

  private agent(proxy: string): Dispatcher {
    let a = this.agents.get(proxy);
    if (!a) {
      a = proxy.startsWith('socks')
        ? new Socks5ProxyAgent(proxy.replace(/^socks5h:/, 'socks5:'))
        : new ProxyAgent(proxy);
      this.agents.set(proxy, a);
    }
    return a;
  }

  async call<T>(
    token: string,
    method: string,
    body: Record<string, unknown>,
    proxy?: string | null,
  ): Promise<TelegramCall<T>> {
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(proxy ? { dispatcher: this.agent(proxy) } : {}),
      });
    } catch (err) {
      // Токен в тексте ошибки fetch не бывает, но на всякий случай его не пересказываем.
      const m =
        err instanceof Error
          ? `${err.name} ${err.message} ${(err as { cause?: Error }).cause?.message ?? ''}`
          : String(err);
      if (proxy && !/Timeout|Abort/i.test(m)) return { ok: false, status: 0, description: 'proxy' };
      return { ok: false, status: 0, description: /Timeout|Abort/i.test(m) ? 'timeout' : 'network' };
    }
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    } | null;
    if (json?.ok && json.result !== undefined) return { ok: true, result: json.result };
    return {
      ok: false,
      status: json?.error_code ?? res.status,
      description: json?.description ?? res.statusText,
    };
  }

  async sendFile<T>(
    token: string,
    fields: Record<string, string>,
    file: { path: string; name: string },
    proxy?: string | null,
  ): Promise<TelegramCall<T>> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('document', await openAsBlob(file.path), file.name);
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: form,
        // Файл до 50 МБ через медленный канал — даём до 5 минут.
        signal: AbortSignal.timeout(300_000),
        ...(proxy ? { dispatcher: this.agent(proxy) } : {}),
      });
    } catch (err) {
      const m = err instanceof Error ? `${err.name} ${err.message}` : String(err);
      return {
        ok: false,
        status: 0,
        description: /Timeout|Abort/i.test(m) ? 'timeout' : proxy ? 'proxy' : 'network',
      };
    }
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    } | null;
    if (json?.ok && json.result !== undefined) return { ok: true, result: json.result };
    return {
      ok: false,
      status: json?.error_code ?? res.status,
      description: json?.description ?? res.statusText,
    };
  }
}

/** Отказ Telegram — человеческой фразой, с тем, что сделать. */
export function describeTelegramError(status: number, description: string): string {
  const d = description.toLowerCase();
  if (status === 0 && d === 'proxy')
    return 'Не удалось подключиться через прокси: проверьте адрес, порт, логин и пароль прокси.';
  if (status === 0 && d === 'timeout')
    return 'Telegram не ответил за 15 секунд. Если сервер панели в России, Telegram может быть с него недоступен — укажите прокси ниже.';
  if (status === 0) return 'Не удалось связаться с Telegram: нет сети до api.telegram.org с сервера панели.';
  if (status === 401 || d.includes('unauthorized'))
    return 'Токен бота неверный или отозван — возьмите новый у @BotFather.';
  if (d.includes("can't initiate conversation") || d.includes('bot was blocked'))
    return 'Бот не может писать первым: откройте бота в Telegram и нажмите «Старт» (или разблокируйте его).';
  if (d.includes('message thread not found') || d.includes('topic'))
    return 'Тема не найдена: проверьте номер темы после двоеточия или уберите его.';
  if (d.includes('chat not found')) return 'Чат не найден: добавьте бота в группу или проверьте id чата.';
  if (d.includes('not enough rights') || d.includes('have no rights') || d.includes('kicked'))
    return 'У бота нет права писать в этот чат: добавьте его в группу и разрешите отправку сообщений.';
  if (status === 429) return 'Telegram просит подождать: слишком много сообщений. Повторите через минуту.';
  return `Telegram отказал (${status}): ${description}`;
}
