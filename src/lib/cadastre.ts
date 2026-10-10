/**
 * Stored titles are grouped as 0900 031 0017.
 * The screen shows the digits in one run.
 */
export function showCadastre(value: string): string {
  return value.replace(/(\d)[ \u00a0]+(?=\d)/g, '$1');
}
