import type { RemnawaveCert, RemnawaveNode, RemnawaveStats } from '@nodeservice/shared';

/**
 * Состояние подключения Remnawave для тестов: его отдают подменённые ответы `/api/nodes/status`
 * (тесты «Обзора» и Ассистента). Тесты и скрипты снимков читают и меняют его напрямую.
 */
export const mockRemnawave: {
  connected: boolean;
  domain: string | null;
  checkedAt: string | null;
  lastAttemptAt: string | null;
  error: string | null;
  stats: RemnawaveStats | null;
  nodes: RemnawaveNode[];
  cert: RemnawaveCert | null;
} = {
  connected: false,
  domain: null,
  checkedAt: null,
  lastAttemptAt: null,
  error: null,
  stats: null,
  nodes: [],
  cert: null,
};

// Режим VITE_MOCK=1: управление из скриншот-сценариев.
if (typeof window !== 'undefined')
  (window as unknown as { __nsMockRemnawave: typeof mockRemnawave }).__nsMockRemnawave = mockRemnawave;

export function seedRemnawave(): void {
  Object.assign(mockRemnawave, {
    connected: false,
    domain: null,
    checkedAt: null,
    lastAttemptAt: null,
    error: null,
    stats: null,
    nodes: [],
    cert: null,
  });
}
