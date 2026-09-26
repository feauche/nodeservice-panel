import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PANEL_MAP } from './assistant.prompt.js';

/**
 * Карта панели в промпте Джарвиса написана вручную, и любое переименование кнопки или раздела делает её
 * ложью: Джарвис будет уверенно называть путь, которого нет. Этот тест сверяет каждую подпись в «ёлочках»
 * и каждый путь маршрута из карты с исходниками интерфейса (без комментариев) и общими контрактами,
 * поэтому расхождение видно сразу, а не по неправильному ответу.
 *
 * Ограничение: подпись ищется как подстрока среди всех строк исходников, поэтому короткое слово («Закрыть»)
 * найдётся почти всегда; ловятся переименования и удаления составных подписей и разделов.
 */
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/**
 * Подписи в «ёлочках», которых нет в исходниках интерфейса, и почему это допустимо: имя => причина.
 * Сейчас пусто: каждая подпись карты найдена в интерфейсе. Добавляйте сюда только то, что приходит из API
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

/** Подписи карты, которых нет в интерфейсе и нет среди исключений. */
const missingLabels = (map: string): string[] =>
  labelsOf(map).filter((l) => !NOT_UI.has(l) && !corpus.includes(norm(l)));

describe('карта панели в промпте Джарвиса', () => {
  const labels = labelsOf(PANEL_MAP);

  it('исходники интерфейса найдены и подписей в карте достаточно (защита от пустой проверки)', () => {
    expect(uiFiles.length).toBeGreaterThan(50);
    expect(sharedFiles.length).toBeGreaterThan(5);
    expect(labels.length).toBeGreaterThan(80);
  });

  it('каждая подпись из карты есть в интерфейсе', () => {
    const missing = missingLabels(PANEL_MAP);
    expect(
      missing,
      missing
        .map((l) => `Такой подписи в интерфейсе нет: «${l}». Обновите карту панели в assistant.prompt.ts`)
        .join('\n'),
    ).toEqual([]);
  });

  it('проверка умеет падать: устаревшие подписи из прошлой карты находятся', () => {
    const stale =
      'Блок «Опасная зона», кнопки «Открыть сервер» и «Закрыть вручную», меню «Установить агента».';
    expect(missingLabels(stale)).toEqual(['Опасная зона', 'Открыть сервер', 'Закрыть вручную']);
  });

  it('исключения NOT_UI не устаревают: они всё ещё в карте и всё ещё не найдены в интерфейсе', () => {
    for (const [label, why] of NOT_UI) {
      expect(why.length, label).toBeGreaterThan(15);
      expect(labels, `«${label}» больше не упоминается в карте: уберите из NOT_UI`).toContain(label);
      expect(corpus.includes(norm(label)), `«${label}» теперь есть в интерфейсе: уберите из NOT_UI`).toBe(
        false,
      );
    }
  });

  it('пути разделов из карты совпадают с маршрутами интерфейса', () => {
    const routesDir = join(webSrc, 'routes');
    const routes = new Set<string>();
    for (const f of walk(routesDir, (p) => /\.tsx$/.test(p))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/createFileRoute\('([^']*)'\)/g)) {
        // Файловые маршруты: «incidents_» уводит из вложенности layout, «$id» — параметр пути.
        const path = (m[1] ?? '')
          .split('/')
          .map((seg) => (seg.startsWith('$') ? ':param' : seg.replace(/_$/, '')))
          .join('/');
        routes.add(path === '' ? '/' : path);
      }
    }
    expect(routes.size).toBeGreaterThan(10);

    const paths = [...PANEL_MAP.matchAll(/\((\/[a-z0-9/<>-]*)\)/g)].map((m) =>
      (m[1] ?? '').replace(/<[^>]+>/g, ':param'),
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        '/',
        '/servers',
        '/incidents',
        '/incidents/:param',
        '/incidents/autofix',
        '/settings',
        '/audit',
        '/assistant',
        '/knowledge',
      ]),
    );
    const unknown = paths.filter((p) => !routes.has(p));
    expect(
      unknown,
      unknown
        .map((p) => `Такого маршрута в интерфейсе нет: ${p}. Обновите карту панели в assistant.prompt.ts`)
        .join('\n'),
    ).toEqual([]);
  });
});
