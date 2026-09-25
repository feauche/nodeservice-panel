import hljs from 'highlight.js/lib/common';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import nginx from 'highlight.js/lib/languages/nginx';
import { createContext, Fragment, type ReactNode, useContext } from 'react';

import { HEALTH_COLORS, HEALTH_LABELS, type ServerHealth } from '@/features/servers/server-health';
import { openServer } from '@/features/servers/server-modal-store';
import { cn } from '@/lib/utils';

/** Ячейки строки markdown-таблицы: делим по «|», отбрасываем крайние пустые от обрамляющих труб. */
function splitTableRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|')) r = r.slice(0, -1);
  return r.split('|').map((c) => c.trim());
}

/** Строка-разделитель таблицы: `| --- | :--: |` и т.п. */
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

function tableAlignClass(cell: string): string {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'text-center';
  if (right) return 'text-right';
  return 'text-left';
}

// Языки, которых нет в common-сборке, но важны для VPN/прокси-конфигов.
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('nginx', nginx);

/** Псевдонимы языков из ```-ограды к именам highlight.js. */
const LANG_ALIAS: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  jsonc: 'json',
  html: 'xml',
  md: 'markdown',
  docker: 'dockerfile',
};
/** Короткая метка языка для угла блока. */
const LANG_LABEL: Record<string, string> = {
  bash: 'bash',
  json: 'json',
  yaml: 'yaml',
  python: 'python',
  javascript: 'js',
  typescript: 'ts',
  sql: 'sql',
  xml: 'html',
  css: 'css',
  scss: 'scss',
  ini: 'ini',
  diff: 'diff',
  markdown: 'md',
  go: 'go',
  rust: 'rust',
  nginx: 'nginx',
  dockerfile: 'docker',
};

/**
 * Блок кода с подсветкой (highlight.js) и меткой языка в углу — как в редакторах.
 * highlight.js экранирует исходник, поэтому его HTML безопасен для dangerouslySetInnerHTML.
 */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const raw = lang.trim().toLowerCase();
  const norm = LANG_ALIAS[raw] ?? raw;
  let html: string;
  let detected = norm;
  if (norm && hljs.getLanguage(norm)) {
    html = hljs.highlight(code, { language: norm, ignoreIllegals: true }).value;
  } else {
    const auto = hljs.highlightAuto(code);
    html = auto.value;
    detected = auto.language ?? '';
  }
  const label = LANG_LABEL[detected] ?? (detected || raw || 'txt');
  return (
    <div className="relative my-3">
      <span className="pointer-events-none absolute top-2 right-2 z-10 select-none rounded-[5px] bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-text-3">
        {label}
      </span>
      <pre className="ns-code overflow-x-auto rounded-[10px] border border-border bg-[#0a0c10] px-3.5 py-3 font-mono text-[12px] leading-relaxed">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js экранирует исходник */}
        <code className="hljs bg-transparent p-0" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

/** Состояние серверов по id: у ссылки на сервер в тексте появляется цветная точка. Без провайдера точки нет. */
export const ServerHealthContext = createContext<Record<string, ServerHealth>>({});

function ServerLink({ id, children }: { id: string; children: ReactNode }) {
  const health = useContext(ServerHealthContext)[id];
  return (
    <button
      type="button"
      title={health ? HEALTH_LABELS[health] : undefined}
      onClick={() => openServer(id)}
      className="cursor-pointer border-0 bg-transparent p-0 text-left font-[inherit] font-semibold text-brand underline decoration-dotted decoration-1 underline-offset-[3px] hover:decoration-solid focus-visible:decoration-solid"
    >
      {health && (
        <span
          aria-hidden="true"
          data-health={health}
          className="mr-1.5 inline-block size-[7px] rounded-full align-middle"
          style={{ background: HEALTH_COLORS[health] }}
        />
      )}
      {children}
    </button>
  );
}

/** Инлайн: **жирный**, `код`, [текст](url). Безопасно — без dangerouslySetInnerHTML. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re =
    /\*\*(.+?)\*\*|`([^`]+?)`|\[([^\]]+?)\]\((https?:\/\/[^)\s]+|server:[0-9a-fA-F-]{36})\)|(?<![*\w])\*([^*\n]+?)\*(?!\*)|(?<!\w)_([^_\n]+?)_(?!\w)/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(text);
  let i = 0;
  while (m) {
    if (m.index > last) nodes.push(<Fragment key={`${keyBase}-t${i}`}>{text.slice(last, m.index)}</Fragment>);
    if (m[1] !== undefined) {
      nodes.push(
        <strong key={`${keyBase}-b${i}`} className="font-semibold text-foreground">
          {renderInline(m[1], `${keyBase}-b${i}`)}
        </strong>,
      );
    } else if (m[2] !== undefined) {
      nodes.push(
        <code
          key={`${keyBase}-c${i}`}
          className="rounded-[4px] bg-surface-2 px-[5px] py-px font-mono text-[0.9em] text-foreground"
        >
          {m[2]}
        </code>,
      );
    } else if (m[5] !== undefined || m[6] !== undefined) {
      nodes.push(
        <em key={`${keyBase}-i${i}`} className="text-foreground italic">
          {renderInline((m[5] ?? m[6]) as string, `${keyBase}-i${i}`)}
        </em>,
      );
    } else if (m[3] !== undefined && m[4]?.startsWith('server:')) {
      // Имя сервера: карточка открывается поверх текущей страницы, без перехода.
      const serverId = m[4].slice('server:'.length);
      nodes.push(
        <ServerLink key={`${keyBase}-s${i}`} id={serverId}>
          {m[3]}
        </ServerLink>,
      );
    } else if (m[3] !== undefined && m[4] !== undefined) {
      nodes.push(
        <a
          key={`${keyBase}-a${i}`}
          href={m[4]}
          target="_blank"
          rel="noreferrer"
          className="text-brand underline-offset-2 hover:underline"
        >
          {m[3]}
        </a>,
      );
    }
    last = m.index + m[0].length;
    i += 1;
    m = re.exec(text);
  }
  if (last < text.length) nodes.push(<Fragment key={`${keyBase}-end`}>{text.slice(last)}</Fragment>);
  return nodes;
}

/** Убираем markdown-разметку из текста заголовка — для оглавления и для якоря. */
function stripMd(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+?)`/g, '$1')
    .replace(/\[([^\]]+?)\]\((?:https?:\/\/[^)\s]+)\)/g, '$1')
    .trim();
}

/** Слаг для id заголовка. Юникод-дружелюбный: кириллица сохраняется. */
function slugify(text: string): string {
  const s = stripMd(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s || 'section';
}

/** Разводим одинаковые id: первый — как есть, дальше `-1`, `-2`… */
function pushUnique(base: string, seen: Map<string, number>): string {
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

export interface TocItem {
  level: number;
  text: string;
  id: string;
}

/**
 * Заголовки статьи для оглавления. id совпадают с теми, что рендер проставляет на заголовках
 * (тот же обход в том же порядке, пропуская код-блоки), — поэтому переход по клику всегда попадает.
 */
export function tocFromMarkdown(content: string): TocItem[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const seen = new Map<string, number>();
  const items: TocItem[] = [];
  let inCode = false;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (!h) continue;
    const text = stripMd(h[2] ?? '');
    if (!text) continue;
    items.push({ level: h[1]?.length ?? 1, text, id: pushUnique(slugify(text), seen) });
  }
  return items;
}

/**
 * Лёгкий безопасный рендер markdown: заголовки, списки, блоки кода, абзацы.
 * Без внешних зависимостей и без raw HTML. При headingIds заголовки получают id-якоря (для оглавления).
 */
export function Markdown({
  content,
  className,
  headingIds = false,
}: {
  content: string;
  className?: string;
  headingIds?: boolean;
}) {
  const seenHeadings = new Map<string, number>();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Блок кода ```
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) {
        buf.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      blocks.push(<CodeBlock key={key++} code={buf.join('\n')} lang={lang} />);
      continue;
    }

    // Таблица: строка с «|» и следующая строка-разделитель `| --- | --- |`.
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1] ?? '').map(tableAlignClass);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(splitTableRow(lines[i] ?? ''));
        i += 1;
      }
      const tKey = key++;
      blocks.push(
        <div key={tKey} className="my-3 overflow-x-auto rounded-[10px] border border-border">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-surface-2">
                {header.map((c, ci) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: колонки статичны
                    key={`th${tKey}-${ci}`}
                    className={cn('px-3 py-2 font-semibold text-foreground', aligns[ci] ?? 'text-left')}
                  >
                    {renderInline(c, `th${tKey}-${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr
                  // biome-ignore lint/suspicious/noArrayIndexKey: строки таблицы статичны
                  key={`tr${tKey}-${ri}`}
                  className="border-t border-border"
                >
                  {header.map((_, ci) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: ячейки статичны
                      key={`td${tKey}-${ri}-${ci}`}
                      className={cn('px-3 py-2 align-top text-text-2', aligns[ci] ?? 'text-left')}
                    >
                      {renderInline(r[ci] ?? '', `td${tKey}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Горизонтальная линия
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-4 border-0 border-t border-border" />);
      i += 1;
      continue;
    }

    // Цитата: подряд идущие строки с «>»
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) {
        quote.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push(
        <blockquote
          key={key++}
          className="my-3 rounded-r-[8px] border-l-[3px] border-brand bg-brand-soft px-3.5 py-2 text-foreground"
        >
          {renderInline(quote.join(' '), `q${key}`)}
        </blockquote>,
      );
      continue;
    }

    // Заголовки
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]?.length ?? 1;
      const text = h[2] ?? '';
      const cls =
        level === 1
          ? 'mt-4 mb-2 font-heading text-[19px] font-bold first:mt-0'
          : level === 2
            ? 'mt-4 mb-1.5 text-[16px] font-semibold first:mt-0'
            : level === 3
              ? 'mt-3 mb-1 text-[14px] font-semibold first:mt-0'
              : 'mt-3 mb-1 text-[13px] font-semibold text-text-2 first:mt-0';
      const headingId = headingIds ? pushUnique(slugify(text), seenHeadings) : undefined;
      blocks.push(
        <div key={key++} id={headingId} className={cn(cls, headingIds && 'scroll-mt-4')}>
          {renderInline(text, `h${key}`)}
        </div>,
      );
      i += 1;
      continue;
    }

    // Списки (- / * / 1.)
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*([-*]|\d+\.)\s+/, ''));
        i += 1;
      }
      const ListTag = ordered ? 'ol' : 'ul';
      blocks.push(
        <ListTag
          key={key++}
          className={`my-2 flex flex-col gap-1 pl-5 text-text-2 ${ordered ? 'list-decimal' : 'list-disc'}`}
        >
          {items.map((it, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: строки markdown статичны и не переупорядочиваются
            <li key={`${key}-${idx}`}>{renderInline(it, `li${key}-${idx}`)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    // Пустая строка
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Абзац (собираем подряд идущие строки)
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^(#{1,4})\s|^\s*([-*]|\d+\.)\s|^\s*>|^\s*(-{3,}|\*{3,})\s*$/.test(lines[i] ?? '') &&
      !(lines[i] ?? '').trimStart().startsWith('```')
    ) {
      para.push(lines[i] ?? '');
      i += 1;
    }
    // Страховка от зацикливания: строка, которую не взял ни один блок, идёт абзацем и всегда съедается.
    if (para.length === 0) {
      para.push(lines[i] ?? '');
      i += 1;
    }
    blocks.push(
      <p key={key++} className="my-2 leading-relaxed text-text-2">
        {renderInline(para.join(' '), `p${key}`)}
      </p>,
    );
  }

  return <div className={className}>{blocks}</div>;
}
