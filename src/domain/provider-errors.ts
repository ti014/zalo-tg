const AMBIGUOUS_PROVIDER_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * True when the TCP connection was never established, so the provider cannot
 * have received the request. node-fetch drops `syscall` and keeps only the
 * message ("... reason: connect ETIMEDOUT 1.2.3.4:443"); undici nests it in
 * `cause`. Only durable workers use this to retry instead of parking as
 * UNKNOWN; fallback paths keep treating it as ambiguous so a transport outage
 * never downgrades a message format.
 */
export function isConnectPhaseFailure(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 3; depth += 1) {
    if ((current as { syscall?: unknown }).syscall === 'connect') return true;
    const message = current instanceof Error ? current.message : String(current);
    if (/\bconnect E[A-Z]+ \S+:\d+/.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Returns true when a provider may have accepted a request even though the
 * bridge did not receive a definitive response. Such failures must not enter
 * a fallback send path because that can duplicate the provider-side effect.
 */
export function isAmbiguousProviderFailure(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? '');
  const message = error instanceof Error ? error.message : String(error);
  return AMBIGUOUS_PROVIDER_CODES.has(code)
    || /timeout|timed out|socket hang up|connection reset/i.test(message);
}
