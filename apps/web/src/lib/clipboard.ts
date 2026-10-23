/**
 * Скопировать текст. Буфер обмена браузера есть только на https и localhost, а панель, поставленную во
 * внутреннюю сеть, открывают и по http (http://10.10.10.104) — там копируем через скрытое поле.
 * `near` — кнопка, по которой нажали: поле ставится рядом с ней, иначе окно диалога забирает фокус
 * у поля, и копируется пустота. false — не вышло ни так, ни так.
 */
export async function copyText(text: string, near?: Element | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Браузер запретил (например, вкладка без фокуса) — пробуем через поле.
  }
  return copyViaField(text, near?.parentElement ?? document.body);
}

function copyViaField(text: string, host: Element): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  field.tabIndex = -1;
  Object.assign(field.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '1px',
    height: '1px',
    opacity: '0',
  });
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  host.append(field);
  field.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  field.remove();
  back?.focus();
  return ok;
}
