import { EventEmitter } from 'node:events';

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

  it('обрыв соединения, взятого из пула, тоже не роняет панель', async () => {
    // Транзакция между двумя запросами: соединение выдано из пула, и пул его уже не слушает. Подмена базы
    // при восстановлении завершает такую сессию — событие 'error' соединения без слушателя роняло процесс.
    const pool = createPool('postgres://nodeservice:x@127.0.0.1:1/nodeservice');
    const client = new EventEmitter();
    pool.emit('connect', client);
    const gone = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });
    expect(() => client.emit('error', gone)).not.toThrow();
    expect(() => client.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    await pool.end();
  });
});
