import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema.js';

/** GitHub без токена даёт 60 запросов в час — кешируем на 6 часов, этого хватает с запасом. */
const CACHE_MS = 6 * 3_600_000;
const FETCH_TIMEOUT_MS = 6_000;

/**
 * Последний релиз агента на GitHub (тег вида v0.6.0). Сеть недоступна или лимит — вернём null,
 * чек-лист покажет «не удалось узнать», а не сломается.
 */
@Injectable()
export class AgentReleasesService {
  private readonly log = new Logger(AgentReleasesService.name);
  private cache: { value: string | null; at: number } | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {}

  async latest(): Promise<string | null> {
    if (this.config.get('NODE_ENV') === 'test') return null;
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const value = await this.fetchLatest();
    // Неудачу тоже кешируем, но ненадолго: не долбить GitHub при каждой проверке.
    this.cache = { value, at: value ? Date.now() : Date.now() - CACHE_MS + 15 * 60_000 };
    return value;
  }

  private async fetchLatest(): Promise<string | null> {
    const repo = this.config.get('AGENT_REPO');
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'nodeservice-panel' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.log.warn(`GitHub releases ${repo}: HTTP ${res.status}`);
        return null;
      }
      const body = (await res.json()) as { tag_name?: unknown };
      return typeof body.tag_name === 'string' && /^v?\d+\.\d+/.test(body.tag_name) ? body.tag_name : null;
    } catch (err) {
      this.log.warn(`GitHub releases ${repo}: ${(err as Error).message}`);
      return null;
    }
  }
}
