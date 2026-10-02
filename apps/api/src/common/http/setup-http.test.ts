import { describe, expect, it } from 'vitest';

import { shouldApplyCsrf } from './setup-http.js';

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
