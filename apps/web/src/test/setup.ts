import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';

import { resetCsrfToken } from '@/lib/api';
import { resetMockState } from './msw/handlers';
import { server } from './msw/server';

// jsdom не умеет то, что нужно input-otp (клетки кода).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
document.elementFromPoint ??= () => null;

// Radix (Select и т.п.) использует эти API указателя/скролла, которых нет в jsdom.
if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
}
HTMLElement.prototype.scrollIntoView ??= () => {};

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
