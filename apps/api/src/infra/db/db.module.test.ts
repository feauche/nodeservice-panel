import { describe, expect, it } from 'vitest';

import { createPool } from './db.module.js';

describe('пул соединений с базой', () => {
  it('обрыв простаивающего соединения не роняет панель', async () => {
    // Базу перезапустили или подменили при восстановлении из копии: пул сообщает об этом событием 'error'.
    // Без слушателя это исключение мимо всех try/catch — процесс падал, при восстановлении посреди подмены базы.
    const pool = createPool('postgres://nodeservice:x@127.0.0.1:1/nodeservice');
    const gone = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });
    expect(() => pool.emit('error', gone)).not.toThrow();
    await pool.end();
  });
});
