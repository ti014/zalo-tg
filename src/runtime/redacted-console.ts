const TELEGRAM_TOKEN_PATTERN = /[0-9]{6,12}:[A-Za-z0-9_-]{30,}/g;
const SENSITIVE_KEY_PATTERN = /authorization|cookie|credential|secret|token|api[_-]?hash/i;
const MAX_DEPTH = 6;

function redactString(value: string, secrets: readonly string[]): string {
  let redacted = value.replace(TELEGRAM_TOKEN_PATTERN, '[REDACTED_TELEGRAM_TOKEN]');
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    redacted = redacted.split(secret).join('[REDACTED_SECRET]');
  }
  return redacted;
}

export function redactLogValue(
  value: unknown,
  secrets: readonly string[] = [],
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (value instanceof URL) return redactString(value.toString(), secrets);
  if (Buffer.isBuffer(value)) return `[Buffer ${value.byteLength} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return `[${value.constructor?.name ?? 'Object'}]`;
  seen.add(value);

  if (value instanceof Error) {
    const error = value as Error & { code?: unknown; cause?: unknown };
    return {
      name: error.name,
      message: redactString(error.message, secrets),
      ...(error.code !== undefined ? { code: redactLogValue(error.code, secrets, seen, depth + 1) } : {}),
      ...(error.stack ? { stack: redactString(error.stack, secrets) } : {}),
      ...(error.cause !== undefined
        ? { cause: redactLogValue(error.cause, secrets, seen, depth + 1) }
        : {}),
    };
  }

  if (Array.isArray(value)) {
    return value.map(item => redactLogValue(item, secrets, seen, depth + 1));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : redactLogValue(item, secrets, seen, depth + 1);
  }
  return redacted;
}

let installed = false;

export function installConsoleRedaction(secrets: readonly string[]): void {
  if (installed) return;
  installed = true;
  const normalizedSecrets = secrets.map(secret => secret.trim()).filter(Boolean);
  for (const method of ['debug', 'error', 'info', 'log', 'warn'] as const) {
    const original = console[method].bind(console);
    console[method] = ((...args: unknown[]) => {
      original(...args.map(value => redactLogValue(value, normalizedSecrets)));
    }) as typeof console[typeof method];
  }
}
