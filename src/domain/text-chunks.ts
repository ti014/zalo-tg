export interface TextMention {
  pos: number;
  uid: string;
  len: number;
}

export interface TextChunk {
  text: string;
  start: number;
  end: number;
  mentions: TextMention[];
}

function graphemeBoundaries(text: string): number[] {
  const boundaries = [0];
  const segmenter = new Intl.Segmenter('vi', { granularity: 'grapheme' });
  for (const segment of segmenter.segment(text)) {
    boundaries.push(segment.index + segment.segment.length);
  }
  return boundaries;
}

function boundaryAtOrBefore(boundaries: readonly number[], target: number, minimum: number): number {
  let low = 0;
  let high = boundaries.length - 1;
  let result = minimum;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = boundaries[middle]!;
    if (value <= target) {
      if (value > minimum) result = value;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function preferredBoundary(text: string, start: number, hardEnd: number): number {
  for (const separator of ['\n\n', '\n', ' ']) {
    const index = text.lastIndexOf(separator, hardEnd - 1);
    if (index > start) return Math.min(hardEnd, index + separator.length);
  }
  return hardEnd;
}

function avoidMentionSplit(
  candidate: number,
  start: number,
  hardEnd: number,
  mentions: readonly TextMention[],
): number {
  const crossing = mentions.find(mention => (
    mention.pos < candidate && mention.pos + mention.len > candidate
  ));
  if (!crossing) return candidate;
  if (crossing.pos > start) return crossing.pos;
  const mentionEnd = crossing.pos + crossing.len;
  return mentionEnd <= hardEnd ? mentionEnd : candidate;
}

/** Split text without breaking graphemes or valid mention ranges. */
export function splitZaloText(
  text: string,
  mentions: readonly TextMention[] = [],
  maxLength = 2_000,
): TextChunk[] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new Error('maxLength must be a positive safe integer.');
  }
  if (!text) return [];

  const boundaries = graphemeBoundaries(text);
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = boundaryAtOrBefore(boundaries, Math.min(text.length, start + maxLength), start);
    if (hardEnd <= start) throw new Error('maxLength is smaller than one grapheme cluster.');
    let end = hardEnd;
    if (hardEnd < text.length) {
      end = preferredBoundary(text, start, hardEnd);
      end = avoidMentionSplit(end, start, hardEnd, mentions);
      end = boundaryAtOrBefore(boundaries, end, start);
      if (end <= start) end = hardEnd;
    }

    const chunkMentions = mentions
      .filter(mention => mention.pos >= start && mention.pos + mention.len <= end)
      .map(mention => ({ ...mention, pos: mention.pos - start }));
    chunks.push({ text: text.slice(start, end), start, end, mentions: chunkMentions });
    start = end;
  }
  return chunks;
}

export function buildReplyAutoMention(input: {
  group: boolean;
  replyIsTelegramOriginated: boolean;
  uid?: string;
  displayName?: string;
}): { prefix: string; mention: TextMention } | null {
  const uid = input.uid?.trim();
  const displayName = input.displayName?.trim();
  if (!input.group || input.replyIsTelegramOriginated || !uid || !displayName) return null;
  const mentionText = `@${displayName}`;
  return {
    prefix: `${mentionText} `,
    mention: { pos: 0, uid, len: mentionText.length },
  };
}
