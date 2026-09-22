import { type ArgumentsHost, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AUTH_PROBLEM } from '@nodeservice/shared';
import { ZodValidationException } from 'nestjs-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type ProblemDetails, ProblemDetailsFilter, problem } from './problem-details.filter.js';

function run(exception: unknown): { status: number; type: string; body: ProblemDetails } {
  const out = { status: 0, type: '', body: {} as ProblemDetails };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    type(t: string) {
      out.type = t;
      return this;
    },
    json(b: ProblemDetails) {
      out.body = b;
    },
  };
  const req = { originalUrl: '/api/test', id: 'req-1' };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(exception, host);
  return out;
}

describe('ProblemDetailsFilter', () => {
  it('HttpException → problem+json с заголовком по-русски и requestId', () => {
    const r = run(new NotFoundException('Сервер не найден'));
    expect(r.status).toBe(404);
    expect(r.type).toBe('application/problem+json');
    expect(r.body).toMatchObject({
      status: 404,
      title: 'Не найдено',
      detail: 'Сервер не найден',
      instance: '/api/test',
      requestId: 'req-1',
    });
  });

  it('ZodError → 422 со списком полей', () => {
    const parsed = z.object({ login: z.string().min(3) }).safeParse({ login: 'a' });
    if (parsed.success) throw new Error('ожидалась ошибка');
    const r = run(parsed.error);
    expect(r.status).toBe(422);
    expect(r.body.errors?.[0]?.path).toBe('login');
  });

  it('ZodValidationException (nestjs-zod DTO) → 400 с type validation и полями', () => {
    const parsed = z.object({ login: z.string().min(3) }).safeParse({ login: 'a' });
    if (parsed.success) throw new Error('ожидалась ошибка');
    const r = run(new ZodValidationException(parsed.error));
    expect(r.status).toBe(400);
    expect(r.body.type).toBe(AUTH_PROBLEM.validation);
    expect(r.body.errors?.[0]?.path).toBe('login');
  });

  it('неизвестная ошибка → 500 без утечки деталей', () => {
    const r = run(new Error('секретная причина'));
    expect(r.status).toBe(500);
    expect(r.body.detail).not.toContain('секретная');
  });

  it('403 сохраняет detail из исключения', () => {
    const r = run(
      new ForbiddenException({
        detail: 'Нужен повторный ввод пароля',
        type: 'https://nodeservice.dev/problems/step-up',
      }),
    );
    expect(r.body.type).toContain('step-up');
    expect(r.body.detail).toBe('Нужен повторный ввод пароля');
  });
});

describe('ProblemDetailsFilter: расширения', () => {
  it('extensions попадают в корень, headers — в ответ', () => {
    const headers: Record<string, string> = {};
    const out = { status: 0, body: {} as ProblemDetails };
    const res = {
      status(code: number) {
        out.status = code;
        return this;
      },
      type() {
        return this;
      },
      json(b: ProblemDetails) {
        out.body = b;
      },
      setHeader(k: string, v: string) {
        headers[k] = v;
      },
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ originalUrl: '/x' }) }),
    } as unknown as ArgumentsHost;
    new ProblemDetailsFilter().catch(
      problem(429, {
        type: 'https://nodeservice.dev/problems/auth/throttled',
        detail: 'Подожди',
        extensions: { retryAfterSeconds: 30 },
        headers: { 'Retry-After': '30' },
      }),
      host,
    );
    expect(out.status).toBe(429);
    expect(out.body.retryAfterSeconds).toBe(30);
    expect(out.body.title).toBe('Слишком много запросов');
    expect(headers['Retry-After']).toBe('30');
  });
});
