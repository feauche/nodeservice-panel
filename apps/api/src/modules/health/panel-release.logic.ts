export function versionParts(value: string): [number, number, number] | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function plainVersion(value: string): string | null {
  const parts = versionParts(value);
  return parts ? parts.join('.') : null;
}

/** true, только если latest строго новее current. */
export function newerVersion(current: string, latest: string): boolean {
  const a = versionParts(current);
  const b = versionParts(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if ((b[i] as number) !== (a[i] as number)) return (b[i] as number) > (a[i] as number);
  }
  return false;
}
