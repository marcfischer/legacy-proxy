import type { AppConfig, DavConfig, ProviderConfig } from "../util/config.js";

export function resolveProvider(cfg: AppConfig, name?: string): ProviderConfig {
  const key = name ?? cfg.defaultProvider;
  const p = cfg.providers[key];
  if (!p) throw new Error(`Unknown provider: ${key}`);
  return interpolate(p);
}

/**
 * Find the provider key whose `domains` list contains the email's domain.
 * Returns undefined when the username is not an email address or no provider
 * claims the domain. Matching is case-insensitive.
 */
export function providerForEmail(cfg: AppConfig, email?: string): string | undefined {
  if (!email) return undefined;
  const at = email.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return undefined;
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (p.domains?.some((d) => d.trim().toLowerCase() === domain)) return name;
  }
  return undefined;
}

/**
 * Decide which provider key a login should use. Resolution order:
 *   1. an explicit provider supplied by the client (e.g. `/api/login` body),
 *   2. the provider claiming the email domain of the username,
 *   3. the configured default provider.
 */
export function resolveProviderName(
  cfg: AppConfig,
  opts: { explicit?: string; username?: string },
): string {
  if (opts.explicit) return opts.explicit;
  return providerForEmail(cfg, opts.username) ?? cfg.defaultProvider;
}

function interpolate(p: ProviderConfig): ProviderConfig {
  return {
    imap: { ...p.imap, host: env(p.imap.host) },
    smtp: { ...p.smtp, host: env(p.smtp.host) },
    sieve: p.sieve ? { ...p.sieve, host: env(p.sieve.host) } : null,
    carddav: dav(p.carddav),
    caldav: dav(p.caldav),
    auth: p.auth,
  };
}

function dav(d: DavConfig | null | undefined): DavConfig | null {
  if (!d) return null;
  const opt = (s?: string) => (s ? env(s) : undefined);
  return {
    ...d,
    host: env(d.host),
    basePath: opt(d.basePath),
    principalPath: opt(d.principalPath),
    username: opt(d.username),
    password: opt(d.password),
  };
}

function env(s: string): string {
  return s.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_m, k: string) => process.env[k] ?? "");
}
