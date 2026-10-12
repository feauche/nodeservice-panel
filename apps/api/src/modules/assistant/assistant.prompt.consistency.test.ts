import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PLAYBOOKS, renderPlaybook } from './assistant.playbooks.js';
import { buildSystem, PANEL_MAP } from './assistant.prompt.js';
import { REFERENCE, referenceById } from './assistant.reference.js';

/**
 * Карта панели в подсказке Ассистента и подробная карта (тема navigation) написаны вручную, и любое
 * переименование кнопки или раздела делает их ложью: Ассистент будет уверенно называть путь, которого нет.
 * Этот тест сверяет каждую подпись в «ёлочках» и каждый путь маршрута из карт с исходниками интерфейса
 * (без комментариев) и общими контрактами, а в остальных текстах (правила проверок, справочник, плейбуки)
 * — подписи в цепочках пути «А» → «Б». Обратная сверка: каждый раздел меню и настроек есть в карте.
 *
 * Ограничение: подпись ищется как подстрока среди всех строк исходников, поэтому короткое слово («Закрыть»)
 * найдётся почти всегда; ловятся переименования и удаления составных подписей и разделов.
 */
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/**
 * Подписи в «ёлочках», которых нет в исходниках интерфейса, и почему это допустимо: имя => причина.
 * Сейчас пусто: каждая подпись карт найдена в интерфейсе. Добавляйте сюда только то, что приходит из API
 * или данных (например, название служебной статьи), а не подпись кнопки или вкладки.
 */
const NOT_UI = new Map<string, string>();

const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

function walk(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

const webSrc = join(ROOT, 'apps/web/src');
const isUiSource = (f: string): boolean =>
  /\.tsx?$/.test(f) &&
  !/\.test\.tsx?$/.test(f) &&
  !/[\\/](test|mocks)[\\/]/.test(f) &&
  !f.endsWith('routeTree.gen.ts');
const uiFiles = walk(webSrc, isUiSource);
/** Комментарии не считаются подписями: устаревшее название может жить в комментарии годами. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[\s;{}(,])\/\/.*$/gm, '$1');
const sharedFiles = walk(join(ROOT, 'packages/shared/src'), (f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
const corpus = norm(
  [...uiFiles, ...sharedFiles].map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n'),
);
const inUi = (label: string): boolean => corpus.includes(norm(label));

/** Все подписи «…» из карты, разбитые по «→» и «/», без повторов. */
function labelsOf(map: string): string[] {
  const labels = new Set<string>();
  for (const m of map.matchAll(/«([^»]+)»/g))
    for (const part of (m[1] ?? '').split(/→|\//)) {
      const label = part.trim();
      if (label) labels.add(label);
    }
  return [...labels];
}

/**
 * Подписи из цепочек пути: «А» → окно ноды → «Б» → «В». Берётся подпись в «ёлочках» прямо перед «→» (после
 * пояснения в скобках) и прямо после него; слова без «ёлочек» («окно ноды») и цитаты вне цепочек не берутся.
 */
function chainLabels(text: string): string[] {
  const labels = new Set<string>();
  const parts = text.split('→');
  for (let i = 0; i < parts.length - 1; i += 1) {
    const left = (parts[i] ?? '').replace(/\s*\([^()]*\)\s*$/, '').trimEnd();
    const right = (parts[i + 1] ?? '').trimStart();
    for (const m of [left.match(/«([^»]+)»$/), right.match(/^«([^»]+)»/)])
      for (const part of (m?.[1] ?? '').split(/\s\/\s/)) if (part.trim()) labels.add(part.trim());
  }
  return [...labels];
}

/** Подписи карты, которых нет в интерфейсе и нет среди исключений. */
const missingLabels = (map: string): string[] => labelsOf(map).filter((l) => !NOT_UI.has(l) && !inUi(l));
const missingChainLabels = (text: string): string[] =>
  chainLabels(text).filter((l) => !NOT_UI.has(l) && !inUi(l));

const navigation = referenceById('navigation')?.render() ?? '';
/** Тексты с путями по интерфейсу, кроме самих карт: подсказка целиком, справочник и плейбуки. */
const pathTexts: Array<[string, string]> = [
  ['подсказка', buildSystem('intermediate')],
  ...REFERENCE.filter((t) => t.id !== 'changelog').map((t): [string, string] => [`тема ${t.id}`, t.render()]),
  ...PLAYBOOKS.map((p): [string, string] => [`плейбук ${p.id}`, renderPlaybook(p)]),
];

function routesOfUi(): Set<string> {
  const routes = new Set<string>();
  for (const f of walk(join(webSrc, 'routes'), (p) => /\.tsx$/.test(p))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/createFileRoute\('([^']*)'\)/g)) {
      // Файловые маршруты: «incidents_» уводит из вложенности layout, «$id» — параметр пути.
      const path = (m[1] ?? '')
        .split('/')
        .map((seg) => (seg.startsWith('$') ? ':param' : seg.replace(/_$/, '')))
        .join('/');
      routes.add(path === '' ? '/' : path);
    }
  }
  return routes;
}

const pathsOf = (text: string): string[] =>
  [...text.matchAll(/\((\/[a-z0-9/<>-]*)\)/g)].map((m) => (m[1] ?? '').replace(/<[^>]+>/g, ':param'));

/** Разделы меню и настроек из исходников: { to: '/…', label: '…' }. */
function menuEntries(file: string): Array<{ to: string; label: string }> {
  const src = stripComments(readFileSync(join(webSrc, file), 'utf8'));
  return [...src.matchAll(/\{\s*to:\s*'([^']+)',\s*label:\s*'([^']+)'/g)].map((m) => ({
    to: m[1] ?? '',
    label: m[2] ?? '',
  }));
}

describe('карта панели в подсказке Ассистента', () => {
  const labels = labelsOf(PANEL_MAP);

  it('исходники интерфейса найдены и подписей в картах достаточно (защита от пустой проверки)', () => {
    expect(uiFiles.length).toBeGreaterThan(50);
    expect(sharedFiles.length).toBeGreaterThan(5);
    expect(labels.length).toBeGreaterThan(40);
    expect(labelsOf(navigation).length).toBeGreaterThan(120);
  });

  it('каждая подпись из карты в подсказке есть в интерфейсе', () => {
    const missing = missingLabels(PANEL_MAP);
    expect(
      missing,
      missing
        .map((l) => `Такой подписи в интерфейсе нет: «${l}». Обновите PANEL_MAP в assistant.prompt.ts`)
        .join('\n'),
    ).toEqual([]);
  });

  it('каждая подпись из подробной карты (тема navigation) есть в интерфейсе', () => {
    const missing = missingLabels(navigation);
    expect(
      missing,
      missing
        .map(
          (l) => `Такой подписи в интерфейсе нет: «${l}». Обновите тему navigation в assistant.reference.ts`,
        )
        .join('\n'),
    ).toEqual([]);
  });

  it('пути «А» → «Б» в подсказке, справочнике и плейбуках называют существующие подписи', () => {
    for (const [where, text] of pathTexts) {
      const missing = missingChainLabels(text);
      expect(
        missing,
        missing.map((l) => `${where}: в пути есть подпись «${l}», которой нет в интерфейсе`).join('\n'),
      ).toEqual([]);
    }
    // Защита от пустой проверки: пути действительно разбираются.
    expect(chainLabels(PLAYBOOKS.map(renderPlaybook).join('\n')).length).toBeGreaterThan(15);
  });

  it('проверка умеет падать: устаревшие подписи и пути находятся', () => {
    const stale =
      'Блок «Опасная зона», кнопки «Открыть сервер» и «Закрыть вручную», меню «Установить агента».';
    expect(missingLabels(stale)).toEqual(['Опасная зона', 'Открыть сервер', 'Закрыть вручную']);
    const stalePath =
      'Путь: «Ноды» → окно ноды (по карточке) → «Опасная зона» → «Закрыть вручную»; цитата «Открыть сервер» вне пути.';
    expect(chainLabels(stalePath)).toEqual(['Ноды', 'Опасная зона', 'Закрыть вручную']);
    expect(missingChainLabels(stalePath)).toEqual(['Опасная зона', 'Закрыть вручную']);
  });

  it('исключения NOT_UI не устаревают: они всё ещё в картах и всё ещё не найдены в интерфейсе', () => {
    const all = [...labels, ...labelsOf(navigation)];
    for (const [label, why] of NOT_UI) {
      expect(why.length, label).toBeGreaterThan(15);
      expect(all, `«${label}» больше не упоминается в картах: уберите из NOT_UI`).toContain(label);
      expect(inUi(label), `«${label}» теперь есть в интерфейсе: уберите из NOT_UI`).toBe(false);
    }
  });

  it('пути разделов из карт совпадают с маршрутами интерфейса', () => {
    const routes = routesOfUi();
    expect(routes.size).toBeGreaterThan(10);
    const paths = pathsOf(PANEL_MAP);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/',
        '/nodes',
        '/billing',
        '/billing/providers',
        '/metrics',
        '/incidents',
        '/incidents/:param',
        '/scenarios',
        '/settings',
        '/assistant',
        '/knowledge',
        '/integrations/dpi',
        '/integrations/dns',
        '/integrations/bschecker',
        '/audit',
      ]),
    );
    for (const [where, text] of [
      ['PANEL_MAP в assistant.prompt.ts', PANEL_MAP],
      ['тему navigation в assistant.reference.ts', navigation],
    ] as const) {
      const unknown = pathsOf(text).filter((p) => !routes.has(p));
      expect(
        unknown,
        unknown.map((p) => `Такого маршрута в интерфейсе нет: ${p}. Обновите ${where}`).join('\n'),
      ).toEqual([]);
    }
  });

  it('каждый раздел меню и настроек есть в карте подсказки — с подписью и адресом', () => {
    const entries = [
      ...menuEntries('components/layout/app-shell.tsx'),
      ...menuEntries('routes/settings.tsx'),
    ];
    expect(entries.length).toBeGreaterThan(15);
    const missing = entries.filter(
      (e) => !PANEL_MAP.includes(`«${e.label}»`) || !PANEL_MAP.includes(`(${e.to})`),
    );
    expect(
      missing,
      missing
        .map(
          (e) => `Раздела «${e.label}» (${e.to}) нет в карте: добавьте его в PANEL_MAP в assistant.prompt.ts`,
        )
        .join('\n'),
    ).toEqual([]);
  });
});
