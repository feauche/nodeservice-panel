import { describe, expect, it } from 'vitest';

import { mockMe } from '@/test/msw/handlers';
import { initialsOf, useAuthStore } from './store';

describe('auth store', () => {
  it('lock/unlock пишут флаг в sessionStorage', () => {
    const st = useAuthStore.getState();
    st.lock();
    expect(useAuthStore.getState().locked).toBe(true);
    expect(sessionStorage.getItem('ns-locked')).toBe('1');
    st.unlock();
    expect(useAuthStore.getState().locked).toBe(false);
    expect(sessionStorage.getItem('ns-locked')).toBeNull();
  });

  it('setPendingTotp пишет флаг в sessionStorage', () => {
    useAuthStore.getState().setPendingTotp(true);
    expect(sessionStorage.getItem('ns-pending-totp')).toBe('1');
    useAuthStore.getState().setPendingTotp(false);
    expect(sessionStorage.getItem('ns-pending-totp')).toBeNull();
  });

  it('signedOut чистит me и оба флага', () => {
    const st = useAuthStore.getState();
    st.setMe(mockMe);
    st.lock();
    st.setPendingTotp(true);
    st.signedOut();
    const s = useAuthStore.getState();
    expect(s.me).toBeNull();
    expect(s.locked).toBe(false);
    expect(s.pendingTotp).toBe(false);
    expect(s.hydrated).toBe(true);
    expect(sessionStorage.getItem('ns-locked')).toBeNull();
    expect(sessionStorage.getItem('ns-pending-totp')).toBeNull();
  });

  it('hydrate без сессии сбрасывает locked; с сессией — сохраняет и берёт recoveryCodesLeft из me', () => {
    const st = useAuthStore.getState();
    st.lock();
    st.hydrate({ setupRequired: false, authenticated: true, me: { ...mockMe, recoveryCodesLeft: 4 } });
    expect(useAuthStore.getState().locked).toBe(true);
    expect(useAuthStore.getState().recoveryCodesLeft).toBe(4);
    st.hydrate({ setupRequired: false, authenticated: false });
    const s = useAuthStore.getState();
    expect(s.locked).toBe(false);
    expect(s.me).toBeNull();
    expect(sessionStorage.getItem('ns-locked')).toBeNull();
  });

  it('initialsOf', () => {
    expect(initialsOf('admin')).toBe('AD');
    expect(initialsOf('_x')).toBe('X');
    expect(initialsOf(undefined)).toBe('NS');
  });
});
