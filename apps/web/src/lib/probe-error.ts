/** A completed probe and an available target are different outcomes. Keep raw evidence separately. */
export function explainProbeError(error: string | null): string | null {
  if (!error) return null;
  if (/ECONNREFUSED|ConnectionRefused|connection refused/i.test(error))
    return 'Соединение отклонено. TCP-порт не принял подключение из этой точки.';
  if (
    /dns_fail|ENOTFOUND|EAI_AGAIN|name or service not known|name resolution|resolve.*(?:host|domain)/i.test(
      error,
    )
  )
    return 'Точка проверки не смогла определить IP домена. Данных о доступности порта нет.';
  if (/certificate|CERT_|TLS|SSL/i.test(error))
    return 'Не удалось завершить проверку TLS. Это не подтверждает блокировку IP.';
  if (/timed?\s*out|timeout|ETIMEDOUT|after \d+ms/i.test(error))
    return 'Ответ не получен за время ожидания. Возможны фильтрация, потеря связи или недоступный порт.';
  if (/ENETUNREACH|EHOSTUNREACH|network.*unreachable|no route to host/i.test(error))
    return 'Из этой точки нет маршрута к проверяемому адресу.';
  if (/reset|ECONNRESET/i.test(error)) return 'Соединение было сброшено во время проверки.';
  if (/^[\s\S]*[А-Яа-яЁё]/.test(error)) return error;
  return 'Точка проверки сообщила об ошибке. Откройте технические детали для уточнения.';
}
