/**
 * Create a function that masks secret values in log messages.
 * Values shorter than 3 characters are ignored.
 * Returns an identity function when there are no secrets to mask.
 */
export function createSecretMasker(
  secrets: string[]
): (message: string) => string {
  const filtered = secrets.filter((s) => s.length >= 3);
  if (filtered.length === 0) return (msg) => msg;

  const escaped = filtered.map((s) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  const pattern = new RegExp(escaped.join("|"), "g");

  return (message: string) => message.replace(pattern, "***");
}
