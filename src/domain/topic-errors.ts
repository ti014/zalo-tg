export function isTopicUnavailableError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return [
    'message thread not found',
    'thread not found',
    'topic_closed',
    'topic_deleted',
    'the message thread is closed',
    'message thread is closed',
  ].some(fragment => message.includes(fragment));
}
