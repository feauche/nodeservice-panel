import { describe, expect, it } from 'vitest';

import type { PushInput } from '../notifications/notifications.service.js';
import { PanelAlertsService, type PanelAlertsState } from './panel-alerts.service.js';

const HOUR = 3_600_000;
/** 1 октября 2026, 03:15 по Омску (UTC+6). */
const T0 = new Date('2026-09-30T21:15:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

/** Отметки — «в базе» (объект переживает новый экземпляр службы, как app_meta — перезапуск). */
function make(saved: { state: PanelAlertsState } = { state: {} }) {
  const pushes: PushInput[] = [];
  const svc = new PanelAlertsService(
    {
      load: async () => structuredClone(saved.state),
      save: async (s: PanelAlertsState) => {
        saved.state = structuredClone(s);
      },
    } as never,
    {
      push: async (p: PushInput) => {
        pushes.push(p);
      },
      timeZone: async () => 'Asia/Omsk',
    } as never,
  );
  return { svc, pushes, saved };
}

describe('внутренние оповещения панели о себе самой', () => {
  describe('«Панель перезапустилась после сбоя»', () => {
    it('когда остановилась (последний признак жизни) и когда поднялась — в поясе панели; колокольчик и Telegram', async () => {
      const { svc, pushes } = make();
      await svc.crashed(at(-3 * 60_000), T0);
      expect(pushes).toHaveLength(1);
      const p = pushes[0] as PushInput;
      expect(p).toMatchObject({
        severity: 'warn',
        title: 'Панель перезапустилась после сбоя',
        telegram: { event: 'panel_health' },
        link: { to: '/incidents', label: 'Открыть инциденты' },
      });
      expect(p.body).toBe(
        'Остановилась около 03:12 (последний признак жизни), снова работает с 03:15 (UTC+6). Штатной остановки перед этим не было — так бывает, когда панель падает с ошибкой, ей не хватает памяти или сервер панели выключается внезапно. Пока панель не работала, она не следила за серверами и не присылала тревог.',
      );
    });

    it('остановилась в другой день — с датой', async () => {
      const { svc, pushes } = make();
      await svc.crashed(new Date('2026-09-29T17:50:00Z'), T0);
      expect(pushes[0]?.body).toMatch(
        /^Остановилась около 29 сентября, 23:50 \(последний признак жизни\), снова работает с 03:15 \(UTC\+6\)\./,
      );
    });

    it('не чаще раза в сутки; повторы за это время склеиваются и называются в следующем сообщении', async () => {
      const { svc, pushes, saved } = make();
      await svc.crashed(at(-60_000), T0);
      await svc.crashed(at(HOUR - 60_000), at(HOUR));
      await svc.crashed(at(5 * HOUR - 60_000), at(5 * HOUR));
      expect(pushes).toHaveLength(1);
      // Перезапуск панели отметки не теряет: они в базе.
      const again = make(saved);
      await again.svc.crashed(at(25 * HOUR - 60_000), at(25 * HOUR));
      expect(again.pushes).toHaveLength(1);
      expect(again.pushes[0]?.body).toMatch(/ С прошлого сообщения это случалось ещё 2 раза\.$/);
      await again.svc.crashed(at(26 * HOUR - 60_000), at(26 * HOUR));
      expect(again.pushes).toHaveLength(1);
    });
  });

  describe('«Метрики не записываются» и «снова записываются»', () => {
    it('сбой — одно сообщение со временем начала; восстановление — одно, сколько не записывались', async () => {
      const { svc, pushes } = make();
      await svc.metricsDown(at(-12 * 60_000), T0);
      await svc.metricsUp(at(20 * 60_000));
      expect(pushes.map((p) => [p.severity, p.title])).toEqual([
        ['warn', 'Метрики не записываются'],
        ['ok', 'Метрики снова записываются'],
      ]);
      expect(pushes[0]?.body).toBe(
        'С 03:03 (UTC+6) панель не может записать метрики серверов в хранилище метрик. Пока это так, графики не пополняются, а панель не видит нагрузку на процессор, память и диск серверов и не заведёт по ним инцидент. Обычно дело в том, что хранилище метрик на сервере панели остановилось или на сервере кончилось место.',
      );
      expect(pushes[1]?.body).toBe('Не записывались 32 мин: на графиках за это время будет пробел.');
      for (const p of pushes) expect(p.telegram?.event).toBe('panel_health');
      // Уже сказали «снова» — повторно не говорим.
      await svc.metricsUp(at(21 * 60_000));
      expect(pushes).toHaveLength(2);
    });

    it('за сутки второй сбой молчит — и «снова» о нём тоже; на следующие сутки — сообщение с числом повторов', async () => {
      const { svc, pushes } = make();
      await svc.metricsDown(at(-11 * 60_000), T0);
      await svc.metricsUp(at(HOUR));
      await svc.metricsDown(at(2 * HOUR), at(2 * HOUR + 11 * 60_000));
      await svc.metricsUp(at(3 * HOUR));
      expect(pushes).toHaveLength(2);
      await svc.metricsDown(at(30 * HOUR), at(30 * HOUR + 11 * 60_000));
      expect(pushes).toHaveLength(3);
      expect(pushes[2]?.body).toMatch(/ С прошлого сообщения запись метрик прерывалась ещё 1 раз\.$/);
    });

    it('о сбое сказали, панель перезапустилась — «снова записываются» всё равно придёт', async () => {
      const first = make();
      await first.svc.metricsDown(at(-11 * 60_000), T0);
      const after = make(first.saved);
      await after.svc.metricsUp(at(HOUR));
      expect(after.pushes.map((p) => p.title)).toEqual(['Метрики снова записываются']);
      expect(after.pushes[0]?.body).toBe(
        'Не записывались 1 ч 11 мин: на графиках за это время будет пробел.',
      );
    });

    it('запись просто идёт — ничего не присылаем', async () => {
      const { svc, pushes } = make();
      await svc.metricsUp(T0);
      expect(pushes).toHaveLength(0);
    });
  });

  describe('панель потеряла обзор сети серверов', () => {
    it('одна системная тревога заменяет повторы по серверам, после восстановления приходит итог', async () => {
      const { svc, pushes } = make();
      await svc.connectivityDown(7, T0);
      await svc.connectivityDown(9, at(60_000));
      await svc.connectivityUp(at(8 * 60_000));
      await svc.connectivityUp(at(9 * 60_000));

      expect(pushes.map((p) => [p.severity, p.title])).toEqual([
        ['warn', 'Панель не может перепроверить связь с серверами'],
        ['ok', 'Панель снова видит сеть серверов'],
      ]);
      expect(pushes[0]).toMatchObject({
        link: { to: '/servers', label: 'Открыть серверы' },
        telegram: { event: 'panel_health' },
      });
      expect(pushes[0]?.body).toContain('независимо проверить 7 серверов');
      expect(pushes[0]?.body).toContain('не будет объявлять эти серверы выключенными');
      expect(pushes[1]).toMatchObject({ center: true, telegram: { event: 'panel_health' } });
      expect(pushes[1]?.body).toContain('после 8 мин');
    });

    it('повторный сбой в те же сутки не создаёт тревогу и поэтому не создаёт ложное восстановление', async () => {
      const { svc, pushes } = make();
      await svc.connectivityDown(3, T0);
      await svc.connectivityUp(at(HOUR));
      await svc.connectivityDown(2, at(2 * HOUR));
      await svc.connectivityUp(at(3 * HOUR));
      expect(pushes.map((p) => p.title)).toEqual([
        'Панель не может перепроверить связь с серверами',
        'Панель снова видит сеть серверов',
      ]);
    });

    it('открытое состояние переживает перезапуск панели', async () => {
      const first = make();
      await first.svc.connectivityDown(4, T0);
      const after = make(first.saved);
      await after.svc.connectivityDown(4, at(5 * 60_000));
      await after.svc.connectivityUp(at(10 * 60_000));
      expect(after.pushes.map((p) => p.title)).toEqual(['Панель снова видит сеть серверов']);
    });
  });

  describe('база не отвечает', () => {
    it('отметки не читаются и не пишутся — оповещение всё равно уходит, а повтор в те же сутки держится в памяти', async () => {
      const pushes: PushInput[] = [];
      const svc = new PanelAlertsService(
        {
          load: async () => {
            throw new Error('connect ECONNREFUSED');
          },
          save: async () => {
            throw new Error('connect ECONNREFUSED');
          },
        } as never,
        {
          push: async (p: PushInput) => {
            pushes.push(p);
          },
          timeZone: async () => 'Asia/Omsk',
        } as never,
      );
      await svc.diskLow({ freeBytes: 1024 ** 3, totalBytes: 40 * 1024 ** 3 }, T0);
      await svc.diskLow({ freeBytes: 1024 ** 3, totalBytes: 40 * 1024 ** 3 }, at(HOUR));
      expect(pushes.map((p) => p.title)).toEqual(['Мало места на сервере панели']);
    });
  });

  describe('«Мало места на сервере панели»', () => {
    const GB = 1024 ** 3;

    it('сколько свободно и что обычно занимает место, без команд; раз в сутки, пока не исправлено', async () => {
      const { svc, pushes } = make();
      await svc.diskLow({ freeBytes: 1.4 * GB, totalBytes: 40 * GB }, T0);
      await svc.diskLow({ freeBytes: 1.3 * GB, totalBytes: 40 * GB }, at(6 * HOUR));
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({
        severity: 'warn',
        title: 'Мало места на сервере панели',
        link: { to: '/settings/backups', label: 'Открыть копии' },
        telegram: { event: 'panel_health' },
      });
      expect(pushes[0]?.body).toBe(
        'Свободно 1,4 ГБ из 40 ГБ (3 %). Когда место кончится, панель перестанет сохранять данные и присылать тревоги. Обычно место занимают резервные копии панели, старые образы Docker и системный журнал сервера. Пока места мало, напомним раз в сутки.',
      );
      await svc.diskLow({ freeBytes: 0.5 * GB, totalBytes: 40 * GB }, at(24 * HOUR));
      expect(pushes).toHaveLength(2);
      expect(pushes[1]?.body).toMatch(/^Свободно 512 МБ из 40 ГБ \(1 %\)\./);
    });
  });
});
