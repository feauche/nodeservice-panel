import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { Injectable, Logger } from '@nestjs/common';

/** Что удалось узнать у геосервисов про IP сервера. */
export interface GeoAnswers {
  /** IP, по которому спрашивали; null — адрес не разрешился или не публичный. */
  ip: string | null;
  /** Коды стран от источников, которые ответили (как ответили, без проверки). */
  answers: string[];
  /** Сколько источников спросили. */
  asked: number;
  /** Почему вообще не спрашивали (адрес не публичный, домен не разрешился). */
  problem?: string;
}

/** Определение страны по адресу сервера. В тестах подменяется. */
export interface GeoLookup {
  detect(host: string): Promise<GeoAnswers>;
}
export const GEO_LOOKUP = Symbol('GEO_LOOKUP');

interface GeoSource {
  id: string;
  url: (ip: string) => string;
  /** Достаёт код страны из тела ответа; null — источник ответил, но страны в ответе нет. */
  parse: (body: string) => string | null;
}

const json = (body: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(body) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Публичные HTTPS-сервисы без ключей: каждый отвечает своей базой, поэтому решаем голосованием. */
export const GEO_SOURCES: readonly GeoSource[] = [
  {
    id: 'ipwho.is',
    url: (ip) => `https://ipwho.is/${ip}`,
    parse: (b) => (json(b)?.success === false ? null : str(json(b)?.country_code)),
  },
  { id: 'country.is', url: (ip) => `https://api.country.is/${ip}`, parse: (b) => str(json(b)?.country) },
  {
    id: 'ipinfo.io',
    url: (ip) => `https://ipinfo.io/${ip}/country`,
    parse: (b) => (/^[A-Za-z]{2}$/.test(b.trim()) ? b.trim() : null),
  },
  {
    id: 'geojs.io',
    url: (ip) => `https://get.geojs.io/v1/ip/country/${ip}.json`,
    parse: (b) => str(json(b)?.country),
  },
  {
    id: 'ipquery.io',
    url: (ip) => `https://api.ipquery.io/${ip}`,
    parse: (b) => str((json(b)?.location as Record<string, unknown> | undefined)?.country_code),
  },
  {
    id: 'ipwhois.app',
    url: (ip) => `https://ipwhois.app/json/${ip}`,
    parse: (b) => (json(b)?.success === false ? null : str(json(b)?.country_code)),
  },
  {
    id: 'iplocation.net',
    url: (ip) => `https://api.iplocation.net/?ip=${ip}`,
    parse: (b) => str(json(b)?.country_code2),
  },
];

const TIMEOUT_MS = 6_000;
const BODY_MAX = 16_384;

/** Публичный ли адрес: частные, служебные и документационные сети геосервисам не отправляем. */
export function isPublicIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0, c = 0] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (isIP(ip) === 6) {
    const first = Number.parseInt(ip.split(':')[0] || '0', 16);
    // Глобальные адреса 2000::/3, кроме документационной сети 2001:db8::/32.
    return first >= 0x2000 && first <= 0x3fff && !ip.toLowerCase().startsWith('2001:db8');
  }
  return false;
}

@Injectable()
export class HttpGeoLookup implements GeoLookup {
  private readonly log = new Logger(HttpGeoLookup.name);

  async detect(host: string): Promise<GeoAnswers> {
    // В тестах наружу не ходим: e2e подставляет свой источник.
    if (process.env.NODE_ENV === 'test')
      return { ip: null, answers: [], asked: 0, problem: 'В тестовом окружении геосервисы не опрашиваются.' };
    let ip = host;
    if (!isIP(host)) {
      try {
        ip = (await lookup(host, { family: 4 })).address;
      } catch {
        try {
          ip = (await lookup(host)).address;
        } catch {
          return { ip: null, answers: [], asked: 0, problem: `Домен «${host}» не разрешился в адрес.` };
        }
      }
    }
    if (!isPublicIp(ip))
      return {
        ip: null,
        answers: [],
        asked: 0,
        problem: `Адрес ${ip} не публичный: страну по нему определить нельзя.`,
      };
    const results = await Promise.all(GEO_SOURCES.map((s) => this.ask(s, ip)));
    return { ip, answers: results.filter((r): r is string => r !== null), asked: GEO_SOURCES.length };
  }

  private async ask(src: GeoSource, ip: string): Promise<string | null> {
    try {
      const res = await fetch(src.url(ip), {
        headers: { accept: 'application/json, text/plain', 'user-agent': 'nodeservice-panel' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return src.parse((await res.text()).slice(0, BODY_MAX));
    } catch (err) {
      this.log.debug(`Геосервис ${src.id}: ${(err as Error).message}`);
      return null;
    }
  }
}
