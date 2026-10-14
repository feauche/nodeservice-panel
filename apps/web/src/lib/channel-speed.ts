/**
 * Скорость канала ноды из того, что вывела команда на сервере или что вписал человек. Читает осторожно: вывод, который
 * не удалось понять, не превращается в число — человек видит «число не найдено» и вписывает его сам.
 */

/** Скорость сетевой карты в Мбит/с; у виртуальных серверов вместо числа бывает «Invalid argument» или −1. */
export const CHANNEL_SPEED_COMMAND =
  "cat /sys/class/net/$(ip route show default | awk '{print $5; exit}')/speed";
/** Замер, когда карта скорость не сообщает: печатает Download и Upload в Мбит/с. */
export const CHANNEL_SPEEDTEST_COMMAND = 'apt install -y speedtest-cli && speedtest-cli --simple';
/** Предел поля «Лимит канала» — как в настройках ноды. */
export const CHANNEL_MBPS_MAX = 1_000_000;

export type ChannelSpeed =
  | { kind: 'empty' }
  /** Просто число (или число с единицей): так его и берём. */
  | { kind: 'number'; mbps: number }
  /** Замер скорости: берётся меньшее из Download и Upload — канал считается по меньшему. */
  | { kind: 'measured'; mbps: number; download: number | null; upload: number | null }
  /** Сервер скорость не сообщает («Invalid argument», «Unknown!», −1). */
  | { kind: 'unknown' }
  /** Число нашлось, но так много или мало быть не может. */
  | { kind: 'range' }
  /** Числа в тексте не нашлось или их несколько и непонятно, какое нужное. */
  | { kind: 'unclear' };

const UNIT = String.raw`(?:[kmgкмг]?(?:bit\/s|bit\/с|bps|b\/s|бит\/с))`;
const MEASURE = new RegExp(String.raw`\b(download|upload)\s*:?\s*(\d[\d.,]*)\s*(${UNIT})?`, 'gi');
const SPEED_LINE = new RegExp(String.raw`\bspeed:\s*(unknown!?|\d[\d.,]*)\s*(${UNIT})?`, 'i');
const WHOLE = new RegExp(String.raw`^(\d[\d\s.,]*)\s*(${UNIT})?$`, 'i');
const NEGATIVE = /^[-−–]\s*\d+$/;
const MISSING = /invalid argument|unknown!|no such file|not found|нет такого файла|не найден/i;

/** «1 000», «1000,5», «1,000», «912.31» → число; не число (и «10 20» с пробелом не по тысячам) → null. */
function numberOf(raw: string): number | null {
  const t = raw.trim();
  if (/\s/.test(t) && !/^\d{1,3}(\s\d{3})+([.,]\d+)?$/.test(t)) return null;
  const c = t.replace(/\s/g, '');
  if (/^\d{1,3}(,\d{3})+$/.test(c)) return Number(c.replace(/,/g, ''));
  const n = Number(c.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Значение с единицей → Мбит/с; без единицы это уже Мбит/с. */
function toMbps(value: number, unit: string | undefined): number {
  const u = (unit ?? '').toLowerCase();
  if (u.startsWith('g') || u.startsWith('г')) return value * 1000;
  if (u.startsWith('k') || u.startsWith('к')) return value / 1000;
  return value;
}

const fits = (mbps: number) => mbps > 0 && mbps <= CHANNEL_MBPS_MAX;

export function parseChannelSpeed(input: string): ChannelSpeed {
  const text = input.trim();
  if (!text) return { kind: 'empty' };

  // Замер: «Download: 912.31 Mbit/s» и «Upload: 874.07 Mbit/s» (speedtest-cli --simple, Ookla speedtest).
  const got: { download: number | null; upload: number | null } = { download: null, upload: null };
  for (const m of text.matchAll(MEASURE)) {
    const n = numberOf(m[2] ?? '');
    if (n == null) continue;
    got[(m[1] ?? '').toLowerCase() === 'download' ? 'download' : 'upload'] = toMbps(n, m[3]);
  }
  const found = [got.download, got.upload].filter((x): x is number => x != null);
  if (found.length) {
    const mbps = Math.round(Math.min(...found));
    return fits(mbps) ? { kind: 'measured', mbps, ...got } : { kind: 'range' };
  }

  // Строка ethtool: «Speed: 1000Mb/s», «Speed: Unknown!».
  const line = SPEED_LINE.exec(text);
  if (line) {
    if (/^unknown/i.test(line[1] ?? '')) return { kind: 'unknown' };
    const n = numberOf(line[1] ?? '');
    if (n != null) {
      const mbps = toMbps(n, line[2]);
      return fits(mbps) ? { kind: 'number', mbps } : { kind: 'range' };
    }
  }

  if (MISSING.test(text) || NEGATIVE.test(text)) return { kind: 'unknown' };

  // Одно число, возможно с единицей: «1000», «1 000», «940 Mbps», «1 Gbit/s».
  const whole = WHOLE.exec(text);
  if (whole) {
    const n = numberOf(whole[1] ?? '');
    if (n == null) return { kind: 'unclear' };
    const mbps = toMbps(n, whole[2]);
    return fits(mbps) ? { kind: 'number', mbps } : { kind: 'range' };
  }

  // Вставили кусок консоли с приглашением и командой: ищем единственную строку, где только число.
  const lone = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[-−–]?\d+([.,]\d+)?$/.test(l));
  if (lone.length === 1) {
    const only = lone[0] ?? '';
    if (NEGATIVE.test(only)) return { kind: 'unknown' };
    const n = numberOf(only);
    if (n != null) return fits(n) ? { kind: 'number', mbps: n } : { kind: 'range' };
  }
  return { kind: 'unclear' };
}
