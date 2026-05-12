const USER_CACHE_MAX = 500;
const _uidToName       = new Map<string, string>();
const _normToUid       = new Map<string, string>();
const _groupNameToUid  = new Map<string, Map<string, string>>();

function _normName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

function removeUidFromGroupMaps(uid: string): void {
  for (const groupMap of _groupNameToUid.values()) {
    for (const [name, mappedUid] of groupMap.entries()) {
      if (mappedUid === uid) groupMap.delete(name);
    }
  }
}

export const userCache = {
  save(uid: string, displayName: string): void {
    if (!_uidToName.has(uid) && _uidToName.size >= USER_CACHE_MAX) {
      const firstUid = _uidToName.keys().next().value;
      if (firstUid) {
        const oldName = _uidToName.get(firstUid);
        _uidToName.delete(firstUid);
        if (oldName) _normToUid.delete(_normName(oldName));
        removeUidFromGroupMaps(firstUid);
      }
    }
    _uidToName.set(uid, displayName);
    _normToUid.set(_normName(displayName), uid);
  },

  saveForGroup(uid: string, displayName: string, zaloId: string): void {
    this.save(uid, displayName);
    let groupMap = _groupNameToUid.get(zaloId);
    if (!groupMap) {
      groupMap = new Map<string, string>();
      _groupNameToUid.set(zaloId, groupMap);
    }
    groupMap.set(_normName(displayName), uid);
  },

  resolveByName(rawName: string): string | undefined {
    return _normToUid.get(_normName(rawName));
  },

  resolveByNameInGroup(rawName: string, zaloId: string): string | undefined {
    const norm = _normName(rawName);
    return _groupNameToUid.get(zaloId)?.get(norm) ?? _normToUid.get(norm);
  },

  getName(uid: string): string | undefined {
    return _uidToName.get(uid);
  },
};

export interface ZaloFriend {
  userId:      string;
  displayName: string;
  alias?:      string;
}

const FRIENDS_TTL_MS = 5 * 60 * 1000;

let _friends:    ZaloFriend[] = [];
let _friendsTs:  number       = 0;

export const friendsCache = {
  set(list: ZaloFriend[]): void {
    _friends   = list;
    _friendsTs = Date.now();
  },

  search(query: string, limit = 10): ZaloFriend[] {
    const q = query.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
    return _friends
      .filter(f => {
        const searchName = (f.alias || f.displayName).toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
        const realName   = f.displayName.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
        return searchName.includes(q) || realName.includes(q);
      })
      .slice(0, limit);
  },

  isFresh(): boolean {
    return _friends.length > 0 && Date.now() - _friendsTs < FRIENDS_TTL_MS;
  },
};

export interface ZaloGroup {
  groupId:     string;
  name:        string;
  totalMember: number;
}

const GROUPS_TTL_MS = 5 * 60 * 1000;
let _groups:   ZaloGroup[] = [];
let _groupsTs: number      = 0;

export const groupsCache = {
  set(list: ZaloGroup[]): void {
    _groups   = list;
    _groupsTs = Date.now();
  },

  search(query: string, limit = 10): ZaloGroup[] {
    const q = query.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
    return _groups
      .filter(g => {
        const n = g.name.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
        return n.includes(q);
      })
      .slice(0, limit);
  },

  isFresh(): boolean {
    return _groups.length > 0 && Date.now() - _groupsTs < GROUPS_TTL_MS;
  },
};
