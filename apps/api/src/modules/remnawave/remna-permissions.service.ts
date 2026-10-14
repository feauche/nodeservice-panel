import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { getJson, RemnawaveApiError } from './remnawave-client.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';
/** Права ключа на Host Remnawave: чтение — для «Затронутых Host», изменение — для шагов сценария с Host. */
export const HOSTS_READ_SCOPE = 'hosts:list';
export const HOSTS_UPDATE_SCOPE = 'hosts:update';
export const requiredPermissions: Array<{
  scope: string;
  label: string;
  why: string;
  /** Чтение: запрос, которым право проверяется само. Без него право на изменение видно только по делу. */
  path?: string;
  /** Когда проверится право на изменение, если его ещё не пробовали. */
  when?: string;
}> = [
  {
    scope: 'bandwidth-stats:nodes-usage',
    label: 'История трафика',
    why: 'Графики трафика нод за выбранный период',
    path:
      '/api/bandwidth-stats/nodes?start=' +
      new Date().toISOString().slice(0, 10) +
      '&end=' +
      new Date().toISOString().slice(0, 10),
  },
  {
    scope: 'system:nodes-metrics',
    label: 'Метрики нод',
    why: 'Онлайн и показатели по нодам',
    path: '/api/system/nodes/metrics',
  },
  {
    scope: 'system:metadata',
    label: 'Метаданные панели',
    why: 'Версия и сведения о панели',
    path: '/api/system/metadata',
  },
  { scope: 'nodes:list', label: 'Чтение нод', why: 'Состояние, адреса и метрики нод', path: '/api/nodes' },
  {
    scope: 'system:stats',
    label: 'Общая статистика',
    why: 'Онлайн и суммарный трафик',
    path: '/api/system/stats',
  },
  {
    scope: 'infra-billing:list-providers',
    label: 'Чтение провайдеров',
    why: 'Список провайдеров и связь с нодами',
    path: '/api/infra-billing/providers',
  },
  { scope: 'nodes:update', label: 'Изменение нод', why: 'Выбор другого провайдера для ноды' },
  {
    scope: 'infra-billing:create-provider',
    label: 'Добавление провайдера',
    why: 'Создание провайдера из NodeService',
  },
  {
    scope: 'infra-billing:update-provider',
    label: 'Изменение провайдера',
    why: 'Сохранение названия и сайта в Remnawave',
  },
  {
    scope: 'infra-billing:delete-provider',
    label: 'Удаление провайдера',
    why: 'Удаление по вашему подтверждению',
  },
  { scope: HOSTS_READ_SCOPE, label: 'Чтение Host', why: 'Затронутые Host в сценариях', path: '/api/hosts' },
  // Чтение для Ассистента и карты маршрутов (0.100.0): конфиги нод со сниппетами, сквады, шаблоны, пользователь по имени.
  {
    scope: 'config-profiles:list',
    label: 'Профили конфигурации',
    why: 'Конфиги нод для карты маршрутов и Ассистента',
    path: '/api/config-profiles',
  },
  {
    scope: 'snippets:list',
    label: 'Сниппеты',
    why: 'Общие куски конфигов — без них в профиле видна только ссылка',
    path: '/api/snippets',
  },
  {
    scope: 'internal-squads:list',
    label: 'Внутренние сквады',
    why: 'Ассистент видит, кому какие инбаунды выданы',
    path: '/api/internal-squads',
  },
  {
    scope: 'external-squads:list',
    label: 'Внешние сквады',
    why: 'Шаблоны и настройки подписки групп',
    path: '/api/external-squads',
  },
  {
    scope: 'subscription-template:list',
    label: 'Шаблоны подписки',
    why: 'Ассистент читает шаблоны Xray JSON, Mihomo, sing-box и другие',
    path: '/api/subscription-templates',
  },
  {
    scope: 'users:read',
    label: 'Чтение пользователей',
    why: 'Ассистент находит пользователя по имени — без ссылок и ключей',
    path: '/api/users?size=1&start=0',
  },
  {
    scope: HOSTS_UPDATE_SCOPE,
    label: 'Изменение Host',
    why: 'Шаги сценария «Скрыть Host» и «Изменить имя Host»',
    when: 'Проверится при срабатывании сценария',
  },
];
type Evidence = { state: 'granted' | 'denied' | 'unknown'; checkedAt: string };
@Injectable()
export class RemnaPermissionsService {
  private evidence = new Map<string, Evidence>();
  private cache: { key: string; at: number; result: unknown } | null = null;
  constructor(private readonly store: RemnawaveSettingsStore) {}
  private identity(c: { domain: string; apiKey: string }) {
    return createHash('sha256').update(`${c.domain}\0${c.apiKey}`).digest('hex');
  }
  async observe<T>(
    scope: string,
    c: { domain: string; apiKey: string },
    action: () => Promise<T>,
  ): Promise<T> {
    const key = this.identity(c);
    try {
      const value = await action();
      this.record(key, scope, 'granted');
      return value;
    } catch (e) {
      if (e instanceof RemnawaveApiError && e.kind === 'unauthorized') this.record(key, scope, 'denied');
      throw e;
    }
  }
  private record(key: string, scope: string, state: Evidence['state']) {
    this.evidence.set(key + scope, { state, checkedAt: new Date().toISOString() });
    this.cache = null;
  }
  async check(input?: { domain: string; apiKey: string }) {
    const c = input ?? (await this.store.credentials());
    if (!c)
      return {
        items: requiredPermissions.map(({ path, ...p }) => ({ ...p, state: 'unknown', checkedAt: null })),
      };
    const key = this.identity(c);
    if (this.cache?.key === key && Date.now() - this.cache.at < 14000) return this.cache.result;
    const items = await Promise.all(
      requiredPermissions.map(async ({ path, ...p }) => {
        let evidence = this.evidence.get(key + p.scope);
        if (path) {
          try {
            await getJson(`https://${c.domain}${path}`, c.apiKey);
            evidence = { state: 'granted', checkedAt: new Date().toISOString() };
          } catch (e) {
            evidence = {
              state: e instanceof RemnawaveApiError && e.kind === 'unauthorized' ? 'denied' : 'unknown',
              checkedAt: new Date().toISOString(),
            };
          }
        } else if (evidence && Date.now() - Date.parse(evidence.checkedAt) > 900000) evidence = undefined;
        return { ...p, state: evidence?.state ?? 'unknown', checkedAt: evidence?.checkedAt ?? null };
      }),
    );
    const result = { items };
    this.cache = { key, at: Date.now(), result };
    return result;
  }
}
