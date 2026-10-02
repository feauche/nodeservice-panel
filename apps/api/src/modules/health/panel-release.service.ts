import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type PanelRelease, SHARED_VERSION } from '@nodeservice/shared';

import type { Env } from '../../config/env.schema.js';
import { newerVersion, plainVersion } from './panel-release.logic.js';

const SUCCESS_CACHE_MS = 6 * 60 * 60_000;
const FAILURE_CACHE_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 6_000;

type GitHubRelease = {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  body?: unknown;
};

function dateOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function releaseUrl(value: unknown, repo: string): string {
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.hostname === 'github.com') return url.toString();
    } catch {
      // Ниже вернём безопасный адрес нашего репозитория.
    }
  }
  return `https://github.com/${repo}/releases/latest`;
}

/** Последний стабильный GitHub Release панели. GitHub читает только API, браузер получает готовый ответ. */
@Injectable()
export class PanelReleaseService {
  private readonly log = new Logger(PanelReleaseService.name);
  private cache: { value: PanelRelease; until: number } | null = null;
  private inFlight: Promise<PanelRelease> | null = null;
  /** Подменяются в модульном тесте без сетевых запросов. */
  fetchImpl: typeof fetch = fetch;
  now = (): number => Date.now();

  constructor(private readonly config: ConfigService<Env, true>) {}

  latest(): Promise<PanelRelease> {
    const now = this.now();
    if (this.cache && now < this.cache.until) return Promise.resolve(this.cache.value);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async load(): Promise<PanelRelease> {
    const checkedAt = new Date(this.now()).toISOString();
    const repo = this.config.get('PANEL_REPO');
    let value: PanelRelease;
    try {
      const response = await this.fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `nodeservice-panel/${SHARED_VERSION}`,
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as GitHubRelease;
      const latestVersion = typeof body.tag_name === 'string' ? plainVersion(body.tag_name) : null;
      if (!latestVersion) throw new Error('в релизе нет тега vX.Y.Z');
      const notes =
        typeof body.body === 'string' && body.body.trim() ? body.body.trim().slice(0, 12_000) : null;
      value = {
        currentVersion: SHARED_VERSION,
        latestVersion,
        status: newerVersion(SHARED_VERSION, latestVersion) ? 'available' : 'current',
        checkedAt,
        release: {
          name:
            typeof body.name === 'string' && body.name.trim()
              ? body.name.trim().slice(0, 200)
              : `NodeService Panel v${latestVersion}`,
          url: releaseUrl(body.html_url, repo),
          publishedAt: dateOrNull(body.published_at),
          notes,
        },
      };
      this.cache = { value, until: this.now() + SUCCESS_CACHE_MS };
      return value;
    } catch (error) {
      this.log.warn(`GitHub releases ${repo}: ${error instanceof Error ? error.message : String(error)}`);
      value = {
        currentVersion: SHARED_VERSION,
        latestVersion: null,
        status: 'unavailable',
        checkedAt,
        release: null,
      };
      this.cache = { value, until: this.now() + FAILURE_CACHE_MS };
      return value;
    }
  }
}
