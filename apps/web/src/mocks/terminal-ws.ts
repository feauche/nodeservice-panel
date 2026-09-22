/**
 * Мок веб-терминала для VITE_MOCK=1: подменяет WebSocket для /ws/terminal —
 * отдаёт приглашение и эхом отвечает на ввод (чтобы окно можно было увидеть в dev/скриншотах).
 * Остальные адреса идут в настоящий WebSocket.
 */
const PROMPT = 'Добро пожаловать в NodeService · UTF-8 ✓\r\nroot@de-fra-01:~# ';

export function installMockTerminalSocket(): void {
  const Real = window.WebSocket;

  class MockWs extends EventTarget {
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;

    constructor() {
      super();
      setTimeout(() => {
        this.readyState = 1;
        this.emit('open', new Event('open'));
        this.out({ t: 'y' });
        this.out({ t: 'o', d: PROMPT });
      }, 350);
    }
    private out(msg: unknown) {
      this.emit('message', new MessageEvent('message', { data: JSON.stringify(msg) }));
    }
    private emit(type: 'open' | 'message' | 'close', ev: Event) {
      const handler = (this as unknown as Record<string, ((e: Event) => void) | null>)[`on${type}`];
      handler?.(ev);
      this.dispatchEvent(ev);
    }
    send(raw: string) {
      const m = JSON.parse(raw) as { t: string; d?: string };
      if (m.t === 'i' && m.d) this.out({ t: 'o', d: m.d });
    }
    close() {
      this.readyState = 3;
      this.emit('close', new CloseEvent('close', { code: 1000 }));
    }
  }

  window.WebSocket = new Proxy(Real, {
    construct(target, args: [string, (string | string[])?]) {
      const url = String(args[0] ?? '');
      return url.includes('/ws/terminal')
        ? (new MockWs() as unknown as WebSocket)
        : new target(...(args as ConstructorParameters<typeof WebSocket>));
    },
  });
}
