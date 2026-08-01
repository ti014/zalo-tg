/** Split text into user-perceived characters so truncation never cuts a UTF-16
 * surrogate pair or a combining/ZWJ emoji sequence in half. */
function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), part => part.segment);
  }
  return Array.from(text);
}

/** Truncate a string to `max` visible characters, appending ellipsis if cut. */
export function truncate(text: string, max = 4096): string {
  if (!Number.isInteger(max) || max < 0) throw new Error('max must be a non-negative integer');
  if (max === 0) return '';
  const chars = graphemes(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/** Escape characters special to Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Apply Zalo mention metadata to a plain-text Telegram HTML body. */
export function applyMentionsHtml(
  text: string,
  mentions: ReadonlyArray<{ pos: number; len: number; type: number }>,
): string {
  if (!mentions.length) return escapeHtml(text);

  const sorted = [...mentions].sort((a, b) => a.pos - b.pos);
  let result = '';
  let cursor = 0;

  for (const mention of sorted) {
    if (
      mention.len <= 0
      || mention.pos < cursor
      || mention.pos < 0
      || mention.pos >= text.length
    ) continue;
    if (mention.pos > cursor) result += escapeHtml(text.slice(cursor, mention.pos));
    const end = Math.min(mention.pos + mention.len, text.length);
    result += `<b>${escapeHtml(text.slice(mention.pos, end))}</b>`;
    cursor = end;
  }

  if (cursor < text.length) result += escapeHtml(text.slice(cursor));
  return result;
}

const ZALO_STYLE_TAGS: Readonly<Record<string, string>> = {
  b: 'b',
  i: 'i',
  u: 'u',
  s: 's',
};
const TAG_ORDER = ['b', 'i', 'u', 's'] as const;
type TelegramTag = typeof TAG_ORDER[number];

export interface ZaloStyle {
  start: number;
  len: number;
  /** Supported values are b, i, u and s; unsupported Zalo styles are ignored. */
  st: string;
}

/**
 * Apply Zalo styles and mentions while producing strictly nested Telegram HTML.
 * Crossing source ranges are closed and reopened so Telegram never receives
 * invalid markup such as `<b>foo<i>bar</b>baz</i>`.
 */
export function applyZaloMarkupHtml(
  text: string,
  mentions?: ReadonlyArray<{ pos: number; len: number; type: number; label?: string }>,
  styles?: ReadonlyArray<ZaloStyle>,
): string {
  const starts = new Map<number, TelegramTag[]>();
  const ends = new Map<number, TelegramTag[]>();
  const addEvent = (map: Map<number, TelegramTag[]>, pos: number, tag: TelegramTag): void => {
    const list = map.get(pos);
    if (list) list.push(tag);
    else map.set(pos, [tag]);
  };

  for (const style of styles ?? []) {
    const tag = ZALO_STYLE_TAGS[style.st] as TelegramTag | undefined;
    if (!tag || style.len <= 0 || style.start < 0 || style.start >= text.length) continue;
    const end = Math.min(style.start + style.len, text.length);
    addEvent(starts, style.start, tag);
    addEvent(ends, end, tag);
  }

  const replacements = new Map<number, { end: number; label: string }>();
  const occupied: Array<{ start: number; end: number }> = [];
  for (const mention of [...(mentions ?? [])].sort((a, b) => a.pos - b.pos || b.len - a.len)) {
    if (mention.len <= 0 || mention.pos < 0 || mention.pos >= text.length) continue;
    const end = Math.min(mention.pos + mention.len, text.length);
    if (occupied.some(range => mention.pos < range.end && end > range.start)) continue;
    occupied.push({ start: mention.pos, end });
    addEvent(starts, mention.pos, 'b');
    addEvent(ends, end, 'b');
    if (mention.label) replacements.set(mention.pos, { end, label: mention.label });
  }

  if (starts.size === 0 && replacements.size === 0) return escapeHtml(text);

  const counts: Record<TelegramTag, number> = { b: 0, i: 0, u: 0, s: 0 };
  let openTags: TelegramTag[] = [];
  let result = '';

  const applyEvents = (pos: number): void => {
    for (const tag of ends.get(pos) ?? []) counts[tag] = Math.max(0, counts[tag] - 1);
    for (const tag of starts.get(pos) ?? []) counts[tag] += 1;
  };

  const transition = (): void => {
    const desired = TAG_ORDER.filter(tag => counts[tag] > 0);
    let common = 0;
    while (
      common < openTags.length
      && common < desired.length
      && openTags[common] === desired[common]
    ) common += 1;
    for (let index = openTags.length - 1; index >= common; index -= 1) {
      result += `</${openTags[index]}>`;
    }
    for (let index = common; index < desired.length; index += 1) {
      result += `<${desired[index]}>`;
    }
    openTags = [...desired];
  };

  let pos = 0;
  while (pos < text.length) {
    applyEvents(pos);
    transition();

    const replacement = replacements.get(pos);
    if (replacement) {
      result += escapeHtml(replacement.label);
      for (let skipped = pos + 1; skipped < replacement.end; skipped += 1) {
        applyEvents(skipped);
      }
      pos = replacement.end;
      continue;
    }

    result += escapeHtml(text[pos]!);
    pos += 1;
  }

  applyEvents(text.length);
  transition();
  for (let index = openTags.length - 1; index >= 0; index -= 1) {
    result += `</${openTags[index]}>`;
  }
  return result;
}

export function formatGroupMsg(senderName: string, content: string): string {
  return `<b>${escapeHtml(truncate(senderName, 64))}:</b>\n${escapeHtml(truncate(content))}`;
}

export function formatGroupMsgHtml(senderName: string, bodyHtml: string): string {
  return `<b>${escapeHtml(truncate(senderName, 64))}:</b>\n${bodyHtml}`;
}

export function groupCaption(senderName: string): string {
  return `<b>${escapeHtml(truncate(senderName, 64))}</b>`;
}

export function topicName(name: string, type: 0 | 1): string {
  return graphemes(`${type === 1 ? '👥' : '👤'} ${name}`).slice(0, 128).join('');
}
