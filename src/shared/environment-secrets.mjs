export function environmentSecrets(environment) {
  const secrets = Object.entries(environment)
    .filter(
      ([key, value]) =>
        typeof value === 'string' &&
        value.length > 0 &&
        /(?:API_KEY|SECRET|PASSWORD|VAULT_KEY)$|(?:^|_)TOKEN(?:_|$)/i.test(key),
    )
    .map(([, value]) => value);
  if (typeof environment.DATABASE_URL === 'string' && environment.DATABASE_URL) {
    secrets.push(environment.DATABASE_URL);
    try {
      const password = decodeURIComponent(new URL(environment.DATABASE_URL).password);
      if (password) secrets.push(password);
    } catch {}
  }
  return secrets;
}
