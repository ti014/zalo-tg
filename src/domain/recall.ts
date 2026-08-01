export interface RecallPayload {
  msgId: string | number;
  cliMsgId: string | number;
}

/** Build provider-compatible undo payload fallbacks without losing ID precision. */
export function buildRecallPayloads(input: {
  msgId: string | number;
  cliMsgId?: string | number;
}): RecallPayload[] {
  const candidates: RecallPayload[] = [];
  const add = (payload: RecallPayload): void => {
    const key = `${payload.msgId}:${payload.cliMsgId}`;
    if (!candidates.some(item => `${item.msgId}:${item.cliMsgId}` === key)) {
      candidates.push(payload);
    }
  };

  if (input.cliMsgId !== undefined) add({ msgId: input.msgId, cliMsgId: input.cliMsgId });
  add({ msgId: input.msgId, cliMsgId: input.msgId });
  add({ msgId: input.msgId, cliMsgId: 0 });
  return candidates;
}

export function buildRecallPayloadGroups(input: {
  msgIds: Array<string | number>;
  cliMsgId?: string | number;
}): RecallPayload[][] {
  const seen = new Set<string>();
  const groups: RecallPayload[][] = [];
  for (const msgId of input.msgIds) {
    const key = String(msgId).trim();
    if (!key || key === '0' || seen.has(key)) continue;
    seen.add(key);
    groups.push(buildRecallPayloads({
      msgId,
      ...(groups.length === 0 && input.cliMsgId !== undefined
        ? { cliMsgId: input.cliMsgId }
        : {}),
    }));
  }
  return groups;
}
