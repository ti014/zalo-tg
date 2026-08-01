/** Minimal shape shared by live and catch-up reaction payloads from zca-js. */
export interface ZcaReactionDataLike {
  msgId?: string | number;
  cliMsgId?: string | number;
  content?: {
    rMsg?: Array<{
      gMsgID?: string | number;
      cMsgID?: string | number;
      msgType?: number;
    }>;
  };
}

function normalizeReactionMessageId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const id = String(value).trim();
  return id && id !== '0' ? id : null;
}

/**
 * Return the target IDs carried by a Zalo reaction event.
 * Zalo mobile can emit gMsgID=0 for DMs while cMsgID remains usable.
 */
export function extractReactionTargetMsgIds(
  data: ZcaReactionDataLike | null | undefined,
): string[] {
  if (!data) return [];

  const ids: string[] = [];
  for (const target of data.content?.rMsg ?? []) {
    const globalId = normalizeReactionMessageId(target.gMsgID);
    const clientId = normalizeReactionMessageId(target.cMsgID);
    if (globalId) ids.push(globalId);
    if (clientId) ids.push(clientId);
  }

  const targets = Array.from(new Set(ids));
  if (targets.length > 0) return targets;

  return Array.from(new Set([
    normalizeReactionMessageId(data.msgId),
    normalizeReactionMessageId(data.cliMsgId),
  ].filter((id): id is string => id !== null)));
}

export const ZALO_TO_TELEGRAM_REACTION: Readonly<Record<string, string>> = {
  '/-heart': '❤',
  '/-strong': '👍',
  ':>': '😁',
  ':o': '🤯',
  ":-((": '😢',
  ':((': '😭',
  '--b': '😢',
  ':-h': '😡',
  ':-*': '😘',
  ';xx': '🥰',
  ":')": '🤣',
  '/-shit': '💩',
  '/-break': '💔',
  '/-weak': '👎',
  ';-/': '🤔',
  '/-ok': '👌',
  '_()_': '🙏',
  '/-thanks': '🙏',
  '/-bd': '🎉',
  'x-)': '😎',
};

export const TELEGRAM_TO_ZALO_REACTION: Readonly<Record<string, string>> = {
  '❤': '/-heart',
  '❤️': '/-heart',
  '👍': '/-strong',
  '👎': '/-weak',
  '😄': ':>',
  '😁': ':>',
  '😢': ":-((",
  '😭': ':((',
  '😮': ':o',
  '😱': ':o',
  '😡': ':-h',
  '🤬': ':-h',
  '😘': ':-*',
  '🥰': ';xx',
  '😍': ';xx',
  '🤣': ":')",
  '😂': ":')",
  '💩': '/-shit',
  '🌹': '/-rose',
  '💔': '/-break',
  '😕': ';-/',
  '🤔': ';-/',
  '😉': ';-)',
  '👌': '/-ok',
  '✌️': '/-v',
  '✌': '/-v',
  '🙏': '_()_',
  '👊': '/-punch',
  '🤯': ':o',
  '🎉': '/-bd',
  '🏆': '/-ok',
  '💯': '/-ok',
  '😎': 'x-)',
  '🤩': 'x-)',
  '🔥': '/-heart',
};
