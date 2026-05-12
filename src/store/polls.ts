export interface PollEntry {
  pollId:           number;
  zaloGroupId:      string;
  tgPollMsgId:      number;
  tgOrigPollMsgId?: number;
  tgPollUUID:       string;
  tgScoreMsgId:     number;
  tgThreadId:       number;
  options: {
    option_id: number;
    content:   string;
  }[];
}

const _pollByZaloId = new Map<number, PollEntry>();
const _pollByTgId   = new Map<number, PollEntry>();
const _pollByUUID   = new Map<string, PollEntry>();

export const pollStore = {
  save(entry: PollEntry): void {
    _pollByZaloId.set(entry.pollId, entry);
    _pollByTgId.set(entry.tgPollMsgId, entry);
    _pollByUUID.set(entry.tgPollUUID, entry);
  },

  getByPollId(pollId: number): PollEntry | undefined {
    return _pollByZaloId.get(pollId);
  },

  getByTgMsgId(tgMsgId: number): PollEntry | undefined {
    return _pollByTgId.get(tgMsgId);
  },

  getByTgPollUUID(uuid: string): PollEntry | undefined {
    return _pollByUUID.get(uuid);
  },

  updateScoreMsg(pollId: number, newMsgId: number): void {
    const e = _pollByZaloId.get(pollId);
    if (e) e.tgScoreMsgId = newMsgId;
  },
};
