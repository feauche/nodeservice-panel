import { z } from 'zod';

import { blockCheckResultSchema } from './block-check.js';

/**
 * Реестр проверок сервера (R5/J9). Набор взят из multitest (github.com/saveksme/multitest), но сам multitest
 * панель не качает: он лишь тонкая обёртка, которая скачивает и запускает чужие скрипты. Панель вызывает те же
 * скрипты напрямую и только по https — три варианта multitest, которые качают код по незашифрованному http
 * (censorcheck.tlab.pw, bench.tlab.pw, bench.sh), в реестр не вошли.
 *
 * Чужие скрипты закреплены на проверенной версии (коммит и сумма — в server-checks.scripts.ts у api): новая
 * версия у автора сама на серверы не попадёт. Сама по расписанию панель запускает только свои команды
 * (SERVER_CHECK_AUTO_KEYS); сторонние лёгкие — по кнопке (или Джарвисом по просьбе администратора, но не в
 * автоматическом разборе), тяжёлые — только по кнопке, с предупреждением.
 * Вывод хранится сырым текстом: его читает и объясняет Джарвис, отдельных разборщиков под каждый скрипт нет.
 */
export const SERVER_CHECK_KEYS = [
  'russia_access',
  'cpu',
  'ip_region',
  'geoblock',
  'dpi',
  'ip_quality',
  'iperf3_ru',
  'yabs',
] as const;
export const serverCheckKeySchema = z.enum(SERVER_CHECK_KEYS);
export type ServerCheckKey = z.infer<typeof serverCheckKeySchema>;

export interface ServerCheckMeta {
  label: string;
  /** Что показывает — одной фразой для человека. */
  what: string;
  /** Тяжёлая: долго, много трафика или нагрузки — только вручную, с предупреждением. */
  heavy: boolean;
  /** Сколько примерно идёт — для подсказки у кнопки. */
  duration: string;
  /** Чей скрипт запускается — показываем честно. */
  source: string;
  /**
   * Сторонний скрипт, а не своя команда панели. Такой по расписанию не запускается: взлом чужого
   * репозитория не должен сам доходить до root на всех серверах.
   */
  thirdParty: boolean;
}

export const SERVER_CHECK_META: Record<ServerCheckKey, ServerCheckMeta> = {
  russia_access: {
    label: 'Доступность из России',
    what: 'Проверяет порт ноды с российских серверов парка: TCP, TLS с именем маскировки и передачу данных; сравнивает с зарубежными точками.',
    heavy: false,
    duration: 'обычно 1–3 минуты',
    source: 'NodeService · серверы вашего парка',
    thirdParty: false,
  },
  cpu: {
    label: 'Процессор',
    what: 'Скорость процессора (sysbench): одно ядро и все ядра. Сравнивать серверы между собой и замечать «урезанные» тарифы.',
    heavy: false,
    duration: 'около 30 секунд',
    source: 'sysbench (ставится из пакетов системы, если его нет)',
    thirdParty: false,
  },
  ip_region: {
    label: 'Регион IP',
    what: 'В какой стране видят IP сервера разные базы и сервисы (YouTube, Netflix, ChatGPT и другие). Расхождения — причина «сервис показывает не ту страну».',
    heavy: false,
    duration: '1–2 минуты',
    source: 'github.com/Davoyan/ipregion',
    thirdParty: true,
  },
  geoblock: {
    label: 'Геоблок',
    what: 'Какие зарубежные сервисы блокируют IP сервера по стране (отдают ошибку или страницу «недоступно в вашем регионе»).',
    heavy: false,
    duration: '1–3 минуты',
    source: 'github.com/vernette/censorcheck (режим geoblock)',
    thirdParty: true,
  },
  dpi: {
    label: 'DPI до России',
    what: 'Открываются ли с сервера российские сайты и нет ли признаков фильтрации трафика по содержимому на пути.',
    heavy: false,
    duration: '1–3 минуты',
    source: 'github.com/vernette/censorcheck (режим dpi)',
    thirdParty: true,
  },
  ip_quality: {
    label: 'Качество IP',
    what: 'Репутация IP: тип адреса (хостинг или домашний), риск-оценки, чёрные списки, доступ к стримингам и ИИ-сервисам.',
    heavy: false,
    duration: '2–4 минуты',
    source: 'github.com/xykt/IPQuality (он же IP.Check.Place)',
    thirdParty: true,
  },
  iperf3_ru: {
    label: 'Скорость до России',
    what: 'Реальная скорость канала от сервера до публичных серверов iPerf3 в России.',
    heavy: true,
    duration: '5–10 минут, гоняет сотни мегабайт трафика',
    source: 'github.com/itdoginfo/russian-iperf3-servers',
    thirdParty: true,
  },
  yabs: {
    label: 'Полный замер (YABS)',
    what: 'Диск, сеть до серверов по миру и Geekbench — полная картина производительности сервера.',
    heavy: true,
    duration: '10–20 минут, нагружает диск и процессор, тратит трафик',
    source:
      'github.com/masonr/yet-another-bench-script (он же yabs.sh); fio и iPerf3 ставятся из пакетов системы, а Geekbench 4 скрипт скачивает с сайта Primate Labs — его панель не сверяет',
    thirdParty: true,
  },
};

/** Что панель запускает сама по расписанию: лёгкие проверки своими командами, без сторонних скриптов. */
export const SERVER_CHECK_AUTO_KEYS: readonly ServerCheckKey[] = ['russia_access', 'cpu'];

/** Проверки по расписанию повторяются не чаще раза в столько часов. */
export const SERVER_CHECK_INTERVAL_HOURS = 24;
/** Упавшая проверка по расписанию повторяется сама через столько часов. */
export const SERVER_CHECK_RETRY_FAILED_HOURS = 1;
/** Больше этого вывода не храним: начало и конец остаются, середина вырезается. */
export const SERVER_CHECK_OUTPUT_MAX = 48 * 1024;

export const SERVER_CHECK_PROBLEM = {
  busy: 'urn:nodeservice:problem:server-check-busy',
  heavyConfirm: 'urn:nodeservice:problem:server-check-heavy-confirm',
} as const;

export const serverCheckRunSchema = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid(),
  check: serverCheckKeySchema,
  /**
   * cancelled — панель сама отменила запуск: скачанный сторонний скрипт не совпал с закреплённой версией,
   * на сервере он не запускался. Это не ошибка сервера и не ошибка проверки.
   */
  status: z.enum(['running', 'ok', 'failed', 'cancelled']),
  /** auto — суточный запуск панели (только свои команды), manual — по кнопке или Джарвисом. */
  trigger: z.enum(['auto', 'manual']),
  actorDisplay: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** Вывод скрипта без цветовых кодов. */
  output: z.string(),
  /** Структурированный итог собственной проверки доступности; у остальных проверок null. */
  blockResult: blockCheckResultSchema.nullable().optional(),
  error: z.string().nullable(),
  /** Пересказ Джарвиса по кнопке «Объяснить»; null — ещё не просили. Привязан к этому запуску. */
  explanation: z.string().nullable(),
});
export type ServerCheckRun = z.infer<typeof serverCheckRunSchema>;

/** Последний запуск каждой проверки сервера; проверки, которые ещё не запускались, отсутствуют. */
export const serverChecksResponseSchema = z.object({
  items: z.array(serverCheckRunSchema),
  /** Суточный запуск своих проверок включён (Настройки → Автопроверки). */
  autoEnabled: z.boolean(),
  /**
   * Когда панель сама повторит свои проверки (самая ранняя из них); null — ещё не запускались или суточный
   * запуск выключен.
   */
  nextAutoAt: z.string().nullable(),
});
export type ServerChecksResponse = z.infer<typeof serverChecksResponseSchema>;

export const runServerCheckRequestSchema = z.object({
  /** Для тяжёлых проверок — явное согласие с предупреждением (трафик, нагрузка, время). */
  confirmHeavy: z.boolean().optional(),
});
export type RunServerCheckRequest = z.infer<typeof runServerCheckRequestSchema>;
