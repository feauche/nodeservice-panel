/**
 * Куда вернуться после пароля: адрес страницы, на которой застала блокировка экрана или конец сессии.
 * Живёт в sessionStorage — переживает перезагрузку вкладки, но не уходит в другие.
 */
const KEY = 'ns-return-to';

/** Сами экраны входа, блокировки и первого запуска — туда не возвращаемся. */
const AUTH_SCREENS = /^\/(login|lock|setup)(?=$|[/?#])/;

/** Только свой адрес внутри панели: «//сайт» и «/\сайт» браузер понял бы как чужой сайт. */
export function isReturnPath(href: string): boolean {
  return (
    href.startsWith('/') &&
    !href.startsWith('//') &&
    !href.startsWith('/\\') &&
    href !== '/' &&
    !AUTH_SCREENS.test(href)
  );
}

function currentHref(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/** Запомнить текущую страницу (или переданную); экраны входа не запоминаются, прежний адрес остаётся. */
export function rememberReturnPath(href = currentHref()): void {
  if (!isReturnPath(href)) return;
  try {
    sessionStorage.setItem(KEY, href);
  } catch {
    /* приватный режим — вернёмся на «Обзор» */
  }
}

/** Забрать адрес возврата (один раз); нет — «Обзор». */
export function takeReturnPath(): string {
  let href: string | null = null;
  try {
    href = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    /* приватный режим */
  }
  return href && isReturnPath(href) ? href : '/';
}

/** Выход по своей воле — после следующего входа начинаем с «Обзора». */
export function forgetReturnPath(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* приватный режим */
  }
}
