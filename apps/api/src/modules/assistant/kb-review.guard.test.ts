import { describe, expect, it } from 'vitest';

import { checkReview } from './kb-review.guard.js';

const ARTICLE = `# Перезапуск Xray

Если нода не отвечает дольше 5 минут, проверьте порт 8443:

\`\`\`bash
systemctl status xray
systemctl restart xray
\`\`\`

Подробнее: https://xtls.github.io/config/ и адрес панели 203.0.113.10.

## Логи

Смотрите \`journalctl -u xray -n 200\`.`;

describe('предохранитель ревизии базы знаний', () => {
  it('аккуратная правка принимается, обёртка ```markdown снимается', () => {
    const tidy = ARTICLE.replace('Если нода не отвечает', 'Когда нода не отвечает');
    expect(checkReview(ARTICLE, tidy)).toEqual({ ok: true, text: tidy });
    expect(checkReview(ARTICLE, `\`\`\`markdown\n${tidy}\n\`\`\``)).toEqual({ ok: true, text: tidy });
  });

  it('потеря команды, адреса, числа или заголовка — отказ', () => {
    for (const lost of [
      'systemctl restart xray',
      'https://xtls.github.io/config/',
      '8443',
      '## Логи',
      '200',
    ]) {
      const verdict = checkReview(ARTICLE, ARTICLE.replace(lost, ''));
      expect(verdict.ok, lost).toBe(false);
    }
  });

  it('выдуманные команды и адреса — отказ', () => {
    expect(checkReview(ARTICLE, `${ARTICLE}\n\nЕщё: \`rm -rf /var/lib/xray\``).ok).toBe(false);
    expect(checkReview(ARTICLE, `${ARTICLE}\n\nСм. https://example.com/new`).ok).toBe(false);
    expect(checkReview(ARTICLE, ARTICLE.replace('203.0.113.10', '203.0.113.10 и 198.51.100.7')).ok).toBe(
      false,
    );
  });

  it('вступление вместо статьи, обрезка вдвое и раздувание — отказ', () => {
    expect(checkReview(ARTICLE, `Вот исправленная статья:\n\n${ARTICLE}`).ok).toBe(false);
    expect(checkReview(ARTICLE, ARTICLE.slice(0, 100)).ok).toBe(false);
    expect(checkReview(ARTICLE, `${ARTICLE}\n\n${'Лишний текст. '.repeat(200)}`).ok).toBe(false);
  });

  it('команду из текста можно оформить как код — это не выдумка', () => {
    const plain =
      'Выполните systemctl restart xray и подождите 30 секунд, затем проверьте ноду в панели снова.';
    const coded =
      'Выполните `systemctl restart xray` и подождите 30 секунд, затем проверьте ноду в панели снова.';
    expect(checkReview(plain, coded).ok).toBe(true);
  });
});
