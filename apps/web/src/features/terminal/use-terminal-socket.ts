import { terminalOpenResponseSchema } from '@nodeservice/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, apiErrorMessage } from '@/lib/api';
import type { TerminalTarget } from './terminal-store';

export type TerminalStatus = 'auth' | 'connecting' | 'connected' | 'closed' | 'error';

/** Приёмник вывода: xterm-инстанс, привязанный окном. */
export interface TerminalSink {
  write: (data: string) => void;
}

interface UseTerminalSocket {
  status: TerminalStatus;
  error: string | null;
  /** Привязать xterm (вывод пойдёт в него; ранний вывод буферизуется и дольётся). */
  bindSink: (sink: TerminalSink | null) => void;
  /** Отправить ввод пользователя (из xterm.onData). */
  sendInput: (data: string) => void;
  /** Отправить размер окна терминала. */
  sendResize: (cols: number, rows: number) => void;
  /** Переоткрыть сессию (после завершения/ошибки). */
  reopen: () => void;
}

/**
 * Жизненный цикл одной PTY-сессии: preflight → WebSocket (без step-up — терминал открывается сразу).
 * Реконнекта нет — терминал интерактивный; при обрыве показываем «Сессия завершена».
 */
export function useTerminalSocket(server: TerminalTarget): UseTerminalSocket {
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const sinkRef = useRef<TerminalSink | null>(null);
  const bufferRef = useRef<string[]>([]);
  const sizeRef = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 });

  const write = useCallback((data: string) => {
    if (sinkRef.current) sinkRef.current.write(data);
    else bufferRef.current.push(data);
  }, []);

  const bindSink = useCallback((sink: TerminalSink | null) => {
    sinkRef.current = sink;
    if (sink && bufferRef.current.length > 0) {
      for (const chunk of bufferRef.current) sink.write(chunk);
      bufferRef.current = [];
    }
  }, []);

  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d: data }));
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    sizeRef.current = { cols, rows };
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'r', c: cols, r: rows }));
  }, []);

  const reopen = useCallback(() => {
    bufferRef.current = [];
    setError(null);
    setGeneration((g) => g + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: пересоединяемся при смене сервера и reopen
  useEffect(() => {
    let cancelled = false;
    setStatus('connecting');
    setError(null);

    (async () => {
      let url: string;
      try {
        const res = await api.post(`/servers/${server.id}/terminal`, {}, terminalOpenResponseSchema);
        url = res.url;
      } catch (err) {
        if (cancelled) return;
        setError(apiErrorMessage(err));
        setStatus('error');
        return;
      }
      if (cancelled) return;

      const { cols, rows } = sizeRef.current;
      const sep = url.includes('?') ? '&' : '?';
      const ws = new WebSocket(`${url}${sep}cols=${cols}&rows=${rows}`);
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        let msg: { t?: string; d?: string; m?: string };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.t === 'y') {
          setStatus('connected');
          ws.send(JSON.stringify({ t: 'r', c: sizeRef.current.cols, r: sizeRef.current.rows }));
        } else if (msg.t === 'o' && typeof msg.d === 'string') {
          write(msg.d);
        } else if (msg.t === 'x') {
          setStatus('closed');
        } else if (msg.t === 'e') {
          setError(msg.m ?? 'Ошибка терминала');
          setStatus('error');
        }
      };
      ws.onerror = () => {
        if (cancelled) return;
        setStatus((s) => (s === 'connected' ? 'closed' : s === 'error' ? 'error' : 'error'));
      };
      ws.onclose = () => {
        if (cancelled) return;
        setStatus((s) => (s === 'error' ? 'error' : 'closed'));
      };
    })();

    return () => {
      cancelled = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [server.id, generation]);

  return { status, error, bindSink, sendInput, sendResize, reopen };
}
