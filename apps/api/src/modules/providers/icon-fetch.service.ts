import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PROVIDER_ICON_MAX_BYTES } from '@nodeservice/shared';

import type { Env } from '../../config/env.schema.js';

const FETCH_TIMEOUT_MS = 6_000;
const HTML_MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
/** Запасной кэш иконок по умолчанию; для неизвестных доменов отвечает 404, а не заглушкой. */
const DEFAULT_FALLBACK = 'https://www.google.com/s2/favicons?sz=64&domain={host}';
/**
 * Типы, которые отдаём с нашего origin. SVG принимаем, но чистим от скриптов и обработчиков
 * (sanitizeSvg); плюс эндпоинт иконки шлёт nosniff и CSP sandbox.
 */
const IMAGE_TYPES = new Set([
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/avif',
  'image/bmp',
]);
const UA = 'Mozilla/5.0 (compatible; NodeServicePanel/1.0; +https://github.com/feauche/nodeservice-panel)';

export interface FetchedIcon {
  type: string;
  data: Buffer;
  /** Откуда взяли — показываем в форме «Изменить». */
  sourceUrl: string;
}

/** Литеральные адреса внутренних сетей: панель не должна ходить туда по чужой ссылке. */
export function isPrivateHost(host: string): boolean {
  let h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal'))
    return true;
  // IPv4 внутри IPv6 (::ffff:10.0.0.1) проверяем как IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped?.[1]) h = mapped[1];
  const v = isIP(h);
  if (v === 4) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (v === 6)
    return h === '::' || h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

/**
 * Разрешаем адрес и проверяем каждый ответ DNS: имя вроде evil.example → 10.0.0.1 не пройдёт.
 * Остаточный риск — DNS rebinding между проверкой и запросом; для панели с одним админом,
 * который сам вводит адрес хостера, это приемлемо (запрос идёт только на GET иконки).
 */
async function resolvesToPublic(host: string): Promise<boolean> {
  if (isPrivateHost(host)) return false;
  if (isIP(host)) return true;
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateHost(a.address));
  } catch {
    return false;
  }
}

/**
 * Иконка сайта провайдера: <link rel="icon"> из HTML, иначе /favicon.ico. Только http(s),
 * без внутренних адресов, с таймаутом и лимитами размера — чужой сайт не должен ни повесить,
 * ни раздуть панель. Не нашли — null, это не ошибка.
 */
@Injectable()
export class IconFetchService {
  private readonly log = new Logger(IconFetchService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  async fetch(siteUrl: string): Promise<FetchedIcon | null> {
    let url: URL;
    try {
      url = new URL(siteUrl);
    } catch {
      return null;
    }
    if (!(await this.allowed(url))) return null;

    const candidates: URL[] = [];
    const page = await this.get(url, HTML_MAX_BYTES, 'text/html');
    if (page) {
      for (const href of extractIconLinks(page.data.toString('utf8'))) {
        try {
          candidates.push(new URL(href, page.finalUrl));
        } catch {
          /* кривой href — пропускаем */
        }
      }
    }
    // Сайт без <link rel=icon>: угадываем обычные адреса.
    for (const guess of ['/favicon.ico', '/favicon.svg', '/favicon.png'])
      candidates.push(new URL(guess, page?.finalUrl ?? url));

    const seen = new Set<string>();
    for (const c of candidates) {
      if (seen.has(c.href)) continue;
      seen.add(c.href);
      // href из чужого HTML может вести куда угодно — та же проверка, что и для самого сайта.
      if (!(await this.allowed(c))) continue;
      const icon = await this.image(c);
      if (icon) return icon;
    }
    // Сайт закрыт защитой или иконки нет — пробуем запасной кэш (только имя хоста наружу).
    const fallback = this.fallbackUrl(url.hostname);
    return fallback ? this.image(fallback) : null;
  }

  private fallbackUrl(host: string): URL | null {
    const raw = this.config.get('PROVIDER_ICON_FALLBACK_URL');
    const template =
      raw === undefined ? (this.config.get('NODE_ENV') === 'test' ? '' : DEFAULT_FALLBACK) : raw;
    if (!template) return null;
    try {
      return new URL(template.replace('{host}', encodeURIComponent(host.replace(/^www\./, ''))));
    } catch {
      return null;
    }
  }

  /** Иконка по ручной ссылке: только эта картинка, сайт не сканируется. */
  async fetchDirect(iconUrl: string): Promise<FetchedIcon | null> {
    let url: URL;
    try {
      url = new URL(iconUrl);
    } catch {
      return null;
    }
    if (!(await this.allowed(url))) return null;
    return this.image(url);
  }

  private async image(url: URL): Promise<FetchedIcon | null> {
    const res = await this.get(url, PROVIDER_ICON_MAX_BYTES, 'image/');
    if (!res || res.data.length === 0) return null;
    const type = normalizeType(res.type, url.pathname);
    if (!IMAGE_TYPES.has(type)) return null;
    if (type === 'image/svg+xml') {
      const clean = sanitizeSvg(res.data.toString('utf8'));
      if (!clean) return null;
      return { type, data: Buffer.from(clean, 'utf8'), sourceUrl: url.href };
    }
    return { type, data: res.data, sourceUrl: url.href };
  }

  /** Только http(s) и только публичные адреса (в e2e сайт — локальный http-сервер, там проверка адресов выключена). */
  private async allowed(url: URL): Promise<boolean> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    if (this.config.get('NODE_ENV') === 'test') return true;
    return resolvesToPublic(url.hostname);
  }

  /**
   * GET с ручными редиректами: каждый переход проверяется той же `allowed`, чтобы публичный сайт
   * не увёл запрос на внутренний адрес. Больше MAX_REDIRECTS переходов — сдаёмся.
   */
  private async get(
    start: URL,
    maxBytes: number,
    acceptPrefix: string,
  ): Promise<{ data: Buffer; type: string; finalUrl: URL } | null> {
    try {
      let url = start;
      let res: Response | null = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        res = await fetch(url, {
          headers: {
            'user-agent': UA,
            accept: acceptPrefix === 'image/' ? 'image/*' : 'text/html,*/*;q=0.5',
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.status < 300 || res.status > 399) break;
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location || hop === MAX_REDIRECTS) return null;
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return null;
        }
        if (!(await this.allowed(next))) return null;
        url = next;
        res = null;
      }
      if (!res || !res.ok || !res.body) return null;
      const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      // favicon.ico часто отдают как octet-stream — ему верим по расширению.
      const typeOk =
        type.startsWith(acceptPrefix) ||
        (acceptPrefix === 'image/' &&
          (type === 'application/octet-stream' || type === '') &&
          url.pathname.endsWith('.ico'));
      if (!typeOk) return null;
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > maxBytes) {
          if (acceptPrefix === 'image/') return null;
          break;
        }
        chunks.push(Buffer.from(chunk));
      }
      return { data: Buffer.concat(chunks), type, finalUrl: url };
    } catch (err) {
      this.log.debug(`иконка ${start.href}: ${(err as Error).message}`);
      return null;
    }
  }
}

/** href всех <link rel="…icon…"> в порядке предпочтения: маленькие иконки раньше apple-touch. */
export function extractIconLinks(html: string): string[] {
  const out: Array<{ href: string; score: number }> = [];
  const re = /<link\b[^>]*>/gi;
  for (const tag of html.match(re) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    if (!/\bicon\b/.test(rel)) continue;
    const href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href || href.startsWith('data:')) continue;
    const sizes = /\bsizes\s*=\s*["']?(\d+)x/i.exec(tag)?.[1];
    const px = sizes ? Number(sizes) : 0;
    let score = rel.includes('apple') ? 30 : 10;
    // Явный размер около 32px — лучший кандидат; без размера (favicon.ico) чуть ниже.
    score += px ? Math.abs(px - 32) / 8 : 1;
    if (/\.svg(\?|$)/i.test(href)) score -= 5;
    out.push({ href, score });
  }
  return out.sort((a, b) => a.score - b.score).map((o) => o.href);
}

function normalizeType(type: string, pathname: string): string {
  if (type.startsWith('image/')) return type;
  if (pathname.endsWith('.ico')) return 'image/x-icon';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

/**
 * SVG без активного содержимого: убираем <script>, <foreignObject>, обработчики on*, ссылки
 * javascript: и внешние подгрузки (<use href="http…">, <image href="http…">). Внутри <img> браузер
 * скрипты и так не выполняет, но картинку можно открыть по прямой ссылке — поэтому чистим.
 * Не похоже на SVG — null.
 */
export function sanitizeSvg(src: string): string | null {
  let s = src.replace(/^\uFEFF/, '');
  if (!/<svg[\s>]/i.test(s)) return null;
  s = s.replace(/<!DOCTYPE[^>]*(\[[\s\S]*?\])?[^>]*>/gi, '');
  s = s.replace(/<!ENTITY[^>]*>/gi, '');
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/?>/gi, '');
  s = s.replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '');
  s = s.replace(/<(?:iframe|object|embed|meta|link|base)\b[^>]*>/gi, '');
  // атрибуты on* и javascript:/data: в ссылках
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(
    /\s+(xlink:href|href)\s*=\s*("\s*(?:javascript|data|https?):[^"]*"|'\s*(?:javascript|data|https?):[^']*')/gi,
    '',
  );
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, (m) => (/@import|url\s*\(/i.test(m) ? '' : m));
  if (/<script|onload|onerror|javascript:/i.test(s)) return null;
  return s;
}
