import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

import { resetCsrfToken } from '@/lib/api';
import { resetMockState } from './msw/handlers';
import { server } from './msw/server';

// Node 25+ объявляет собственные localStorage/sessionStorage без файла хранения. Они перекрывают
// реализации jsdom и возвращают undefined, поэтому тестам явно нужны браузерные хранилища.
const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
};
Object.defineProperties(globalThis, {
  localStorage: { value: memoryStorage(), configurable: true },
  sessionStorage: { value: memoryStorage(), configurable: true },
});

// jsdom не считает размеры. Без них ResponsiveContainer из Recharts
// считает график нулевым и засоряет вывод тестов предупреждениями.
const testRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 1024,
  bottom: 768,
  width: 1024,
  height: 768,
  toJSON: () => ({}),
} as DOMRect;
const testSize = { inlineSize: testRect.width, blockSize: testRect.height };

HTMLElement.prototype.getBoundingClientRect = () => testRect;

class ResizeObserverStub {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: testRect,
          borderBoxSize: [testSize],
          contentBoxSize: [testSize],
          devicePixelContentBoxSize: [testSize],
        },
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// input-otp и Radix используют браузерные API, которых нет в jsdom.
document.elementFromPoint ??= () => null;

// Radix (Select и т.п.) использует эти API указателя/скролла, которых нет в jsdom.
if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
}
HTMLElement.prototype.scrollIntoView ??= () => {};
window.scrollTo = vi.fn();
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: vi.fn(() => null),
  configurable: true,
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetMockState();
  resetCsrfToken();
  sessionStorage.clear();
  localStorage.clear();
});
afterAll(() => server.close());
