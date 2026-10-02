import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CountryFlag, hasFlag } from './country-flag';

describe('CountryFlag', () => {
  it('флаг подгружается по коду; у картинки подпись — название страны', async () => {
    render(<CountryFlag code="pl" />);
    const img = await screen.findByRole('img', { name: 'Польша' });
    expect(img.tagName).toBe('IMG');
    expect(img).toHaveAttribute('data-code', 'PL');
    expect(img.getAttribute('src')).toBeTruthy();
  });
  it('рядом с названием флаг декоративный: без подписи для читалок', async () => {
    const { container } = render(<CountryFlag code="NL" decorative />);
    await screen.findByTestId('country-flag-loading').catch(() => null);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('aria-hidden', 'true');
  });
  it('страна без флага в наборе: глобус вместо картинки', async () => {
    expect(hasFlag('AQ')).toBe(true);
    render(<CountryFlag code="ZZ" />);
    expect(await screen.findByTestId('country-flag-none')).toBeInTheDocument();
  });
  it('в наборе есть флаги частых стран', () => {
    for (const c of ['RU', 'NL', 'DE', 'FI', 'PL', 'US']) expect(hasFlag(c), c).toBe(true);
  });
});
