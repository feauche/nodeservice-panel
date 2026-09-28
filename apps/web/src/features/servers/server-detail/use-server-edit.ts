import {
  isExitOnly,
  type NodeWatch,
  normalizeProfilePatch,
  type Server,
  type ServerProfile,
  type ServerUpstream,
  type SshAuth,
  UPSTREAM_ADDRESS_RE,
  type UpdateServerRequest,
  updateServerRequestSchema,
} from '@nodeservice/shared';
import { useState } from 'react';
import { StepUpCancelledError } from '@/features/security/step-up';
import { apiErrorMessage, isApiError } from '@/lib/api';
import { toast } from '@/lib/notify';
import type { CountryPick } from '../country-field';
import { useRefreshInventory, useUpdateServer } from '../servers-api';

export const AUTH_TABS = [
  { key: 'keep', label: 'Не менять' },
  { key: 'password', label: 'Пароль' },
  { key: 'key', label: 'Свой ключ' },
  { key: 'panel-key', label: 'Ключ панели' },
] as const;
export type AuthTab = (typeof AUTH_TABS)[number]['key'];

/** Порядок и вид, в котором профиль хранит панель: по нему определяем, есть ли несохранённые правки. */
export function canon(p: ServerProfile): ServerProfile {
  const n = normalizeProfilePatch({
    roles: p.roles,
    expectedContainers: p.expectedContainers,
    expectedPorts: p.expectedPorts,
    maintenanceWindow: p.maintenanceWindow,
  });
  const roles = n.roles ?? [];
  return {
    roles,
    importance: p.importance,
    maintenanceWindow: n.maintenanceWindow ?? null,
    expectedContainers: n.expectedContainers ?? [],
    expectedPorts: n.expectedPorts ?? [],
    // Вход — только у чистого выхода; иначе он не нужен и не сохраняется.
    upstream: isExitOnly(roles) ? canonUpstream(p.upstream) : null,
  };
}

/** Вход в том виде, в каком его хранит сервер: адрес строчными, пустой «чей» — null. */
export function canonUpstream(u: ServerUpstream | null): ServerUpstream | null {
  if (!u) return null;
  if (u.kind === 'bridge') return { kind: 'bridge', serverId: u.serverId, address: null, owner: null };
  return {
    kind: 'rent',
    serverId: null,
    address: u.address?.trim().toLowerCase() || null,
    owner: u.owner?.trim() || null,
  };
}

/** Почему вход нельзя сохранить; null — можно. */
export function upstreamError(u: ServerUpstream | null): string | null {
  if (!u) return null;
  if (u.kind === 'bridge') return u.serverId ? null : 'Выберите мост.';
  if (!u.address) return 'Укажите адрес входа или выберите «Не указывать».';
  return UPSTREAM_ADDRESS_RE.test(u.address)
    ? null
    : 'Домен или IP, при необходимости с портом: entry.example.com:443';
}

export interface ConnFields {
  name: string;
  host: string;
  port: string;
  sshUser: string;
  tags: string;
  notes: string;
  providerId: string | null;
}
interface ProfileFields {
  profile: ServerProfile;
  nodeWatch: NodeWatch;
}

const splitTags = (raw: string) =>
  raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

const connOf = (s: Server): ConnFields => ({
  name: s.name,
  host: s.host,
  port: String(s.port),
  sshUser: s.sshUser,
  tags: s.tags.join(', '),
  notes: s.notes ?? '',
  providerId: s.providerId,
});
const connKey = (c: ConnFields) =>
  JSON.stringify([
    c.name.trim(),
    c.host.trim(),
    c.port.trim(),
    c.sshUser.trim(),
    splitTags(c.tags),
    c.notes.trim(),
    c.providerId,
  ]);
const profileOf = (s: Server): ProfileFields => ({ profile: canon(s.profile), nodeWatch: s.nodeWatch });
const profileKey = (p: ProfileFields) => JSON.stringify([canon(p.profile), p.nodeWatch]);

/**
 * Черновик поверх сохранённого. Если сохранённое поменялось со стороны (Джарвис, другая вкладка браузера),
 * а черновик не трогали, черновик подтягивается; свои правки не затираются.
 */
function useDraft<T>(saved: T, keyOf: (v: T) => string) {
  const savedKey = keyOf(saved);
  const [st, setSt] = useState({ base: savedKey, value: saved });
  let cur = st;
  if (st.base !== savedKey) {
    const k = keyOf(st.value);
    if (k === st.base) cur = { base: savedKey, value: saved };
    else if (k === savedKey) cur = { ...st, base: savedKey };
  }
  if (cur !== st) setSt(cur);
  return {
    value: cur.value,
    dirty: keyOf(cur.value) !== savedKey,
    update: (fn: (v: T) => T) => setSt((s) => ({ ...s, value: fn(s.value) })),
    reset: () => setSt({ base: savedKey, value: saved }),
  };
}

/**
 * Правки карточки сервера: «Профиль» и «Подключение» живут здесь, а не во вкладках, поэтому переход между
 * вкладками их не сбрасывает, а одна кнопка «Сохранить» отправляет всё сразу одним запросом.
 * Хозяин — окно сервера (перемонтируется при смене сервера, поэтому отдельного сброса по id нет).
 */
export function useServerEdit(server: Server, onConnectionInvalid: () => void) {
  const update = useUpdateServer();
  const refresh = useRefreshInventory();
  const conn = useDraft(connOf(server), connKey);
  const prof = useDraft(profileOf(server), profileKey);
  /** Что выбрали в поле «Страна»; null — не трогали, у сервера остаётся прежнее. */
  const [countryPick, setCountryPick] = useState<CountryPick>(null);
  const [authTab, setAuthTabRaw] = useState<AuthTab>('keep');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const connDirty = conn.dirty || countryPick !== null || authTab !== 'keep';
  const profileDirty = prof.dirty;
  const dirty = connDirty || profileDirty;
  const endpointChanged =
    conn.value.host.trim() !== server.host ||
    conn.value.port.trim() !== String(server.port) ||
    conn.value.sshUser.trim() !== server.sshUser;

  const clearError = (key: string) => setErrors((p) => ({ ...p, [key]: '', form: '' }));
  const setField = <K extends keyof ConnFields>(key: K, v: ConnFields[K]) => {
    conn.update((c) => ({ ...c, [key]: v }));
    clearError(key);
  };
  const setAuthTab = (t: AuthTab) => {
    setAuthTabRaw(t);
    setErrors({});
  };
  const resetAuth = () => {
    setAuthTabRaw('keep');
    setPassword('');
    setPrivateKey('');
    setPassphrase('');
  };

  const reset = () => {
    conn.reset();
    prof.reset();
    setCountryPick(null);
    resetAuth();
    setErrors({});
  };

  const save = async () => {
    if (!dirty || update.isPending) return;
    const patch: UpdateServerRequest = {};
    if (connDirty) {
      const f = conn.value;
      const auth: SshAuth | undefined =
        authTab === 'keep'
          ? undefined
          : authTab === 'password'
            ? { method: 'password', password }
            : authTab === 'key'
              ? { method: 'key', privateKey, ...(passphrase ? { passphrase } : {}) }
              : { method: 'panel-key' };
      const parsed = updateServerRequestSchema.safeParse({
        name: f.name,
        host: f.host,
        port: f.port,
        sshUser: f.sshUser,
        tags: splitTags(f.tags),
        notes: f.notes.trim() ? f.notes.trim() : null,
        providerId: f.providerId,
        ...(countryPick ? { country: countryPick } : {}),
        ...(auth ? { auth } : {}),
      });
      if (!parsed.success) {
        const byPath: Record<string, string> = {};
        for (const issue of parsed.error.issues) byPath[String(issue.path[0])] ??= issue.message;
        setErrors(byPath);
        onConnectionInvalid();
        return;
      }
      Object.assign(patch, parsed.data);
    }
    const c = canon(prof.value.profile);
    const upErr = profileDirty ? upstreamError(c.upstream) : null;
    if (upErr) {
      setErrors((e) => ({ ...e, upstream: upErr }));
      return;
    }
    if (profileDirty) {
      patch.profile = {
        roles: c.roles,
        importance: c.importance,
        maintenanceWindow: c.maintenanceWindow,
        expectedContainers: c.expectedContainers,
        expectedPorts: c.expectedPorts,
        upstream: c.upstream
          ? c.upstream.kind === 'bridge'
            ? { kind: 'bridge', serverId: c.upstream.serverId }
            : { kind: 'rent', address: c.upstream.address, owner: c.upstream.owner }
          : null,
      };
      patch.nodeWatch = prof.value.nodeWatch;
    }
    try {
      const next = await update.mutateAsync({ id: server.id, patch });
      setErrors({});
      setCountryPick(null);
      resetAuth();
      toast.success(
        connDirty && profileDirty
          ? `«${next.name}»: подключение и профиль сохранены.`
          : connDirty
            ? `«${next.name}» сохранён.`
            : 'Профиль сохранён.',
      );
      // Снимка ещё нет, а ожидаемое задано: снимаем состояние сразу, чтобы таблица показала, как обстоят дела.
      if (profileDirty && !next.inventory && (c.expectedContainers.length > 0 || c.expectedPorts.length > 0))
        void refresh.mutateAsync(server.id).catch(() => undefined);
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      if (isApiError(err) && err.errors.length > 0) {
        const byPath: Record<string, string> = {};
        for (const er of err.errors) byPath[er.path] ??= er.message;
        setErrors(byPath);
        if (connDirty) onConnectionInvalid();
      } else setErrors({ form: apiErrorMessage(err) });
    }
  };

  return {
    busy: update.isPending,
    dirty,
    save,
    reset,
    errors,
    connection: {
      dirty: connDirty,
      fields: conn.value,
      setField,
      endpointChanged,
      countryPick,
      setCountryPick,
      authTab,
      setAuthTab,
      password,
      setPassword,
      privateKey,
      setPrivateKey,
      passphrase,
      setPassphrase,
      clearError,
    },
    profile: {
      dirty: profileDirty,
      draft: prof.value.profile,
      patch: (over: Partial<ServerProfile>) => {
        if ('upstream' in over) setErrors(({ upstream: _u, ...rest }) => rest);
        prof.update((p) => ({ ...p, profile: { ...p.profile, ...over } }));
      },
      upstreamError: errors.upstream ?? null,
      nodeWatch: prof.value.nodeWatch,
      setNodeWatch: (nodeWatch: NodeWatch) => prof.update((p) => ({ ...p, nodeWatch })),
    },
  };
}

export type ServerEdit = ReturnType<typeof useServerEdit>;
