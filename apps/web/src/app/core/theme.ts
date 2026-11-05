/**
 * Each organization's identity colour, picked by its position in the group, so it
 * is the same on every page and on the map. The colours are --os-identity-0 … 7
 * from @openstuff-dev/tokens.
 */
const IDENTITY_COLORS = 8;

/** An organization's colour as a CSS variable, so agent mode can re-tint it. */
export function orgColor(index: number): string {
  return `var(--os-identity-${((index % IDENTITY_COLORS) + IDENTITY_COLORS) % IDENTITY_COLORS})`;
}

export function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return (
    words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)
  ).toUpperCase();
}
