/**
 * Когда человек последний раз что-то делал в панели — одно время на все вкладки (localStorage), без обнуления
 * при перерисовке страниц и обновлении данных. По нему работает автоблокировка в браузере, и его же браузер
 * сообщает серверу с каждым запросом (ACTIVITY_HEADER): опросы и перечитывания идут сами и человеком не считаются.
 */

const SHARED_KEY = 'ns-last-activity';
/** Чаще писать в общее время незачем: отсчёт блокировки идёт минутами. */
const SHARE_EVERY_MS = 5_000;
/**
 * Только то, что делает человек. Прокрутки нет: живые списки и чат прокручиваются сами, а человек прокручивает
 * колесом, касанием, клавишами или мышью — это всё здесь есть.
 */
const EVENTS = ['pointerdown', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;

let own = Date.now();
let sharedWrittenAt = 0;
let limitMs = 0;
let onExceed: (() => void) | null = null;
let installed = false;
let lastX = Number.NaN;
let lastY = Number.NaN;

function readShared(): number {
  try {
    return Number(localStorage.getItem(SHARED_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeShared(at: number): void {
  sharedWrittenAt = at;
  try {
    localStorage.setItem(SHARED_KEY, String(at));
  } catch {
    /* приватный режим — считаем только по этой вкладке */
  }
}

/** Последнее действие человека в любой вкладке панели. */
export function lastActivityAt(): number {
  return Math.max(own, readShared());
}

/** Сколько человек ничего не делает, мс. */
export function idleMs(now = Date.now()): number {
  return Math.max(0, now - lastActivityAt());
}

/**
 * Действие человека. Если он вернулся после перерыва дольше срока блокировки — сначала блокировка, а не новый
 * отсчёт: иначе первое же движение мыши после часа отсутствия открывало бы панель без пароля.
 */
export function markActivity(now = Date.now()): void {
  if (limitMs > 0 && now - own >= limitMs && now - lastActivityAt() >= limitMs) {
    const exceed = onExceed;
    configureIdleLimit(0, null);
    exceed?.();
    return;
  }
  own = now;
  if (now - sharedWrittenAt >= SHARE_EVERY_MS) writeShared(now);
}

/** Срок блокировки и что делать, когда он вышел; 0 — автоблокировка выключена (или экран уже заблокирован). */
export function configureIdleLimit(ms: number, exceed: (() => void) | null): void {
  limitMs = ms > 0 ? ms : 0;
  onExceed = limitMs > 0 ? exceed : null;
}

/** Отсчёт заново: пароль только что введён. */
export function resetActivity(now = Date.now()): void {
  own = now;
  writeShared(now);
}

/**
 * Движение мыши считается, только если курсор правда сдвинулся: браузер сам шлёт «движение», когда под
 * неподвижным курсором меняется страница (обновились данные).
 */
function onMouseMove(e: MouseEvent): void {
  if (e.screenX === lastX && e.screenY === lastY) return;
  lastX = e.screenX;
  lastY = e.screenY;
  markActivity();
}

/** Слушать действия человека — один раз на вкладку. */
export function installActivityTracking(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const mark = () => markActivity();
  for (const ev of EVENTS) window.addEventListener(ev, mark, { passive: true, capture: true });
  window.addEventListener('mousemove', onMouseMove, { passive: true, capture: true });
}
