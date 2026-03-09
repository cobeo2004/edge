/**
 * Create a function that masks secret values in log messages.
 * Values shorter than 3 characters are ignored.
 * Returns an identity function when there are no secrets to mask.
 */
export function createSecretMasker(
  secrets: string[]
): (message: string) => string {
  const filtered = [...new Set(secrets.filter((s) => s.length >= 3))];
  if (filtered.length === 0) return (msg) => msg;

  // Sort by descending length so longer secrets match first,
  // preventing partial masking when one secret is a substring of another.
  filtered.sort((a, b) => b.length - a.length);

  const escaped = filtered.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(escaped.join("|"), "g");

  return (message: string) => message.replace(pattern, "***");
}
