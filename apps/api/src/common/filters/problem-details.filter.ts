import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AUTH_PROBLEM } from '@nodeservice/shared';
import type { Request, Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';

/**
 * Единый формат ошибок — RFC 9457 "Problem Details" (application/problem+json).
 * Фронт всегда получает {type,title,status,detail,instance,requestId,errors?}.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: Array<{ path: string; message: string }>;
  /** Дополнительные поля-расширения (RFC 9457 §3.2), например retryAfterSeconds. */
  [extension: string]: unknown;
}

/**
 * Тело HttpException, которое понимает фильтр: type/detail попадают в problem+json,
 * extensions — в корень ответа, headers — в заголовки (например Retry-After).
 */
export interface ProblemBody {
  type?: string;
  detail?: string;
  errors?: ProblemDetails['errors'];
  extensions?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** Удобный конструктор типизированной ошибки для фильтра. */
export function problem(status: number, body: ProblemBody): HttpException {
  return new HttpException(body, status);
}

const TITLES: Record<number, string> = {
  400: 'Неверный запрос',
  401: 'Требуется вход',
  403: 'Доступ запрещён',
  404: 'Не найдено',
  409: 'Конфликт',
  422: 'Данные не прошли проверку',
  429: 'Слишком много запросов',
  500: 'Внутренняя ошибка',
};

function zodIssues(err: ZodError): ProblemDetails['errors'] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly log = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const requestId = typeof req.id === 'string' ? req.id : undefined;

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail: string | undefined;
    let errors: ProblemDetails['errors'];
    let type = 'about:blank';
    let extensions: Record<string, unknown> | undefined;
    let stack: string | undefined;

    if (exception instanceof ZodError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      errors = zodIssues(exception);
      detail = 'Проверьте выделенные поля.';
      type = AUTH_PROBLEM.validation;
    } else if (exception instanceof ZodValidationException) {
      // Тело запроса не прошло DTO (nestjs-zod): 400, но тот же type и список полей.
      status = exception.getStatus();
      const zodError = exception.getZodError();
      errors = zodError instanceof ZodError ? zodIssues(zodError) : undefined;
      detail = 'Проверьте выделенные поля.';
      type = AUTH_PROBLEM.validation;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') detail = body;
      else if (body && typeof body === 'object') {
        const b = body as ProblemBody & { message?: string | string[] };
        detail = b.detail ?? (Array.isArray(b.message) ? b.message.join('; ') : b.message);
        if (b.type) type = b.type;
        if (b.errors) errors = b.errors;
        if (b.extensions) extensions = b.extensions;
        if (b.headers) for (const [k, v] of Object.entries(b.headers)) res.setHeader(k, v);
      }
      // Маршрут не существует (например, интерфейс новее API): дефолтный «Cannot POST /…» — не для людей.
      if (status === HttpStatus.NOT_FOUND && detail?.startsWith('Cannot '))
        detail =
          'Такого адреса в API нет. Если панель только что обновлялась — перезагрузи страницу: интерфейс и сервер могли разойтись версиями.';
    } else {
      stack = exception instanceof Error ? exception.stack : String(exception);
    }

    // Реальную причину логируем до подмены детали на дженерик для 5xx.
    const logDetail = detail;
    if (status >= 500)
      detail = 'Что-то пошло не так на сервере. Идентификатор запроса поможет найти причину в логах.';

    // Любая ошибка обязана оставить след: 5xx — с трейсом, остальные — строкой. Ничего не глотаем молча.
    if (status >= 400) {
      const where = `${req.method ?? '—'} ${req.originalUrl ?? req.url} → ${status}`;
      const cause = logDetail ? ` — ${logDetail}` : '';
      const rid = requestId ? ` [${requestId}]` : '';
      if (status >= 500) {
        this.log.error(`${where}${cause}${rid}`, stack);
      } else {
        const fields = errors?.length ? ` · поля: ${errors.map((e) => e.path || 'тело').join(', ')}` : '';
        this.log.warn(`${where}${cause}${fields}${rid}`);
      }
    }

    const problem: ProblemDetails = {
      ...(extensions ?? {}),
      type,
      title: TITLES[status] ?? 'Ошибка',
      status,
      ...(detail ? { detail } : {}),
      instance: req.originalUrl,
      ...(requestId ? { requestId } : {}),
      ...(errors ? { errors } : {}),
    };
    res.status(status).type('application/problem+json').json(problem);
  }
}
