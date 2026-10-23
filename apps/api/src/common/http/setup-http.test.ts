import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { helmetOptions, shouldApplyCsrf } from './setup-http.js';

describe('shouldApplyCsrf', () => {
  it('защищает браузерный API независимо от регистра маршрута', () => {
    expect(shouldApplyCsrf('/api/servers')).toBe(true);
    expect(shouldApplyCsrf('/API/Servers')).toBe(true);
  });

  it('оставляет только явные машинные API без CSRF независимо от регистра', () => {
    expect(shouldApplyCsrf('/api/agent/v1/poll')).toBe(false);
    expect(shouldApplyCsrf('/API/INTERNAL/update')).toBe(false);
    expect(shouldApplyCsrf('/health')).toBe(false);
  });
});

describe('заголовки безопасности', () => {
  const headers = async (publicUrl: string) => {
    const app = express();
    app.use(helmet(helmetOptions(publicUrl)));
    app.get('/', (_req, res) => res.send('ok'));
    return (await request(app).get('/')).headers;
  };

  it('по https — Cross-Origin-Opener-Policy есть', async () => {
    expect((await headers('https://panel.example.com'))['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('по http во внутренней сети его нет: браузер его там не принимает и ругается в консоли', async () => {
    const h = await headers('http://10.10.10.104');
    expect(h['cross-origin-opener-policy']).toBeUndefined();
    expect(h['x-content-type-options']).toBe('nosniff');
  });
});
