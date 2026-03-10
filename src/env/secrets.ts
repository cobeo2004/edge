const SECRET_KEY_PATTERN = /SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL|AUTH|PRIVATE/i;

export function filterSecretValues(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([key]) => SECRET_KEY_PATTERN.test(key))
    .map(([, value]) => value);
}
