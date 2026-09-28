/** Подразделы «Настройки → Джарвис»: ссылки в левой рейке и `?s=` в адресе страницы. */
export const ASSISTANT_SECTIONS = [
  { key: 'connection', label: 'Подключение' },
  { key: 'behavior', label: 'Поведение' },
  { key: 'permissions', label: 'Разрешения' },
  { key: 'privacy', label: 'Данные для провайдера' },
] as const;

export type AssistantSectionKey = (typeof ASSISTANT_SECTIONS)[number]['key'];

export function assistantSectionOf(raw: unknown): AssistantSectionKey {
  return ASSISTANT_SECTIONS.find((x) => x.key === raw)?.key ?? 'connection';
}
