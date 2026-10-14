import { Inject, Injectable } from '@nestjs/common';

import { DEFAULT_TIME_ZONE, panelTimeZone } from '../../common/panel-time-zone.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { BackupsService } from '../backups/backups.service.js';
import { BsRentalsService } from '../integrations/bs-rentals.service.js';
import { BsCheckerService } from '../integrations/bschecker.service.js';
import { DnsService } from '../integrations/dns.service.js';
import { DpiService } from '../integrations/dpi.service.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { TelegramService } from '../notifications/telegram/telegram.service.js';
import { ProvidersService } from '../providers/providers.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { ScenariosStore } from '../scenarios/scenarios.store.js';
import { SecurityService } from '../security/security.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { PanelDeps } from './assistant.panel-tools.js';
import type { ToolDeps } from './assistant.tools.js';

/**
 * Чтение разделов панели для Ассистента одним местом: сценарии, интеграции, копии, сайты, провайдеры и разделы
 * настроек. Только чтение — те же методы, которыми страницы панели показывают эти данные владельцу.
 */
@Injectable()
export class AssistantPanelReader {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly remnawave: RemnawaveService,
    private readonly scenarios: ScenariosStore,
    private readonly integrations: IntegrationsService,
    private readonly dpi: DpiService,
    private readonly dns: DnsService,
    private readonly bs: BsCheckerService,
    private readonly rentals: BsRentalsService,
    private readonly backups: BackupsService,
    private readonly providers: ProvidersService,
    private readonly panelSettings: SettingsService,
    private readonly telegram: TelegramService,
    private readonly security: SecurityService,
  ) {}

  deps(): PanelDeps & Pick<ToolDeps, 'settings'> {
    const domain = async () => (await this.remnawave.status()).domain;
    return {
      scenarios: {
        rules: async () => this.scenarios.list(await domain()),
        runs: async (limit) => this.scenarios.runs(await domain(), limit),
        marked: async () => this.scenarios.markedHosts(await domain()),
        timeZone: async () => (await panelTimeZone(this.db)) ?? DEFAULT_TIME_ZONE,
        nodeNames: async () => new Map((await this.remnawave.status()).nodes.map((n) => [n.uuid, n.name])),
      },
      integrations: {
        dpi: async () => {
          if (!(await this.integrations.status('dpi')).connected)
            return { connected: false, hint: 'DPI Checker не подключён: «Интеграции» → «DPI Checker».' };
          const [schedule, overview] = await Promise.all([this.dpi.schedule(), this.dpi.overview()]);
          return { connected: true, schedule, overview };
        },
        dns: async () => {
          const [cloudflare, regru] = await Promise.all([
            this.integrations.status('cloudflare'),
            this.integrations.status('regru'),
          ]);
          if (!cloudflare.connected && !regru.connected)
            return {
              connected: false,
              hint: 'DNS-интеграция не подключена: «Интеграции» → «DNS интеграции».',
            };
          const [settings, overview, history] = await Promise.all([
            this.dns.settings(),
            this.dns.overview(),
            this.dns.history(),
          ]);
          return {
            connected: true,
            providers: { cloudflare: cloudflare.connected, regru: regru.connected },
            automatic: settings,
            overview,
            history,
          };
        },
        bs: async () => {
          if (!(await this.integrations.status('bschecker')).connected)
            return { connected: false, hint: 'BS Checker не подключён: «Интеграции» → «BS Checker».' };
          const [workspace, rentals, history] = await Promise.allSettled([
            this.bs.workspace(),
            this.rentals.list(),
            this.bs.history(),
          ]);
          const value = (r: PromiseSettledResult<unknown>) =>
            r.status === 'fulfilled'
              ? r.value
              : { error: r.reason instanceof Error ? r.reason.message : 'не прочитано' };
          return {
            connected: true,
            workspace: value(workspace),
            rentals: value(rentals),
            history: value(history),
          };
        },
      },
      backups: {
        list: () => this.backups.list(),
        settings: () => this.backups.getSettings(),
      },
      providers: () => this.providers.list(),
      sites: () => this.panelSettings.getCustomSites(),
      settings: {
        telegram: () => this.telegram.get(),
        appearance: () => this.panelSettings.getAppearance(),
        security: () => this.security.getPolicy(),
      },
    };
  }
}
