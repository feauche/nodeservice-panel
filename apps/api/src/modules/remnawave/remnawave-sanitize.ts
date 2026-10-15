/**
 * Безопасная копия данных Remnawave для Ассистента: конфиг и настройки Remnawave недоверенные и могут содержать
 * доступы, поэтому до модели доходит только копия без секретов.
 */
export const HIDDEN = '[скрыто]';
const SECRET_FIELDS = new Set([
  'accesskey',
  'apikey',
  'auth',
  'authorization',
  'certificate',
  'certificates',
  'email',
  'id',
  'key',
  'password',
  'passwd',
  'presharedkey',
  'privatekey',
  'publickey',
  'secret',
  'secretkey',
  'seed',
  'mldsa65seed',
  'shortid',
  'shortids',
  'token',
  'uuid',
]);
const PRIVATE_LISTS = new Set(['clients', 'users']);
/**
 * Поля, в названии которых есть признак секрета: clientSecret, botToken, accessToken, webhookUrl, passwordHash.
 * Раньше прятались только точные имена (secret, token, password) — составные проскакивали.
 */
const SECRETISH =
  /secret|token|passw|apikey|privatekey|encryptionkey|signingkey|credential|cookie|signature|webhook|salt|mnemonic|bearer|jwt/;

/**
 * Конфиг Remnawave недоверенный и может содержать доступы: до LLM доходит только безопасная копия.
 * Под секретным именем объект не прячется целиком (passwordSettings: { enabled }) — видно, что включено и выключено,
 * а все строки и числа внутри скрыты (strict).
 */
export function sanitizeRemnawaveProfile(value: unknown, field = '', depth = 0, strict = false): unknown {
  const key = field.toLowerCase().replace(/[_-]/g, '');
  if (PRIVATE_LISTS.has(key) && Array.isArray(value)) return { hidden: true, count: value.length };
  if (value === null || value === undefined) return value;
  const secret = SECRET_FIELDS.has(key) || SECRETISH.test(key);
  const plainObject = typeof value === 'object' && !Array.isArray(value);
  if (secret && !plainObject) return HIDDEN;
  if (strict && typeof value !== 'object') return typeof value === 'boolean' ? value : HIDDEN;
  if (depth >= 12) return '[слишком глубокая структура]';
  if (typeof value === 'string') {
    if (/^(?:vless|vmess|trojan|ss|hysteria2|hy2):\/\//i.test(value)) return HIDDEN;
    const clean = value
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, HIDDEN)
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, HIDDEN);
    return clean.length > 2_000 ? `${clean.slice(0, 2_000)}…` : clean;
  }
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitizeRemnawaveProfile(item, '', depth + 1, strict));
  if (typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([name, item]) => [name, sanitizeRemnawaveProfile(item, name, depth + 1, strict || secret)]),
  );
}
