/** Direct Zalo PC App API helpers used for hidden-member groups and requests. */
import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import axios from 'axios';
import { config } from '../config.js';

const GROUP_DOMAIN = 'https://group-wpa.zaloapp.com';
const PROFILE_DOMAIN = 'https://profile-wpa.zaloapp.com';
const FRIEND_DOMAIN = 'https://friend-wpa.zaloapp.com';
const API_TYPE = 30;
const API_VERSION = 671;
const PC_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ZaloPC/23.12.1 Chrome/102.0.5005.167 Electron/19.1.9 Safari/537.36';

export interface AppSession {
  zpw_enk: string;
  dkey?: string;
  imei: string;
  cookies: Array<{ name: string; value: string; domain: string }>;
}

let session: AppSession | null | undefined;

function sessionPath(): string {
  return path.join(path.dirname(config.zalo.credentialsPath), 'app-session.json');
}

export function loadAppSession(): AppSession | null {
  if (session !== undefined) return session;
  if (!existsSync(sessionPath())) {
    session = null;
    return null;
  }
  try {
    session = JSON.parse(readFileSync(sessionPath(), 'utf8')) as AppSession;
  } catch {
    session = null;
  }
  return session;
}

export function invalidateAppSession(): void { session = undefined; }
export function reloadAppSession(): AppSession | null { session = undefined; return loadAppSession(); }

function aesCipher(key: Buffer): string {
  if (key.length === 16) return 'aes-128-cbc';
  if (key.length === 24) return 'aes-192-cbc';
  if (key.length === 32) return 'aes-256-cbc';
  throw new Error(`Unsupported Zalo app session key length: ${key.length}`);
}

function encodeAes(plaintext: string, encodedKey: string): string {
  const key = Buffer.from(encodedKey, 'base64');
  const cipher = crypto.createCipheriv(aesCipher(key), key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

function decodeAes(ciphertext: string, encodedKey: string): string {
  const key = Buffer.from(encodedKey, 'base64');
  const decipher = crypto.createDecipheriv(aesCipher(key), key, Buffer.alloc(16));
  const encrypted = Buffer.from(decodeURIComponent(ciphertext), 'base64');
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function commonParams(imei: string): Record<string, string> {
  return { zpw_type: String(API_TYPE), zpw_ver: String(API_VERSION), imei };
}

function cookieHeader(cookies: AppSession['cookies'], url: string): string {
  const hostname = new URL(url).hostname;
  return cookies
    .filter(cookie => hostname.endsWith(cookie.domain) || hostname === cookie.domain)
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export interface AppGroupData {
  name?: string;
  avt?: string;
  memVerList?: string[];
  currentMems?: Array<{ id: string; dName?: string; zaloName?: string }>;
  totalMember?: number;
  hasMoreMember?: number;
  adminIds?: string[];
  creatorId?: string;
}

async function encryptedPost<T>(
  domain: string,
  endpoint: string,
  body: unknown,
  appSession: AppSession,
): Promise<T | null> {
  const url = `${domain}${endpoint}`;
  try {
    const response = await axios.post<{ error_code: number; data?: string; error_message?: string }>(
      url,
      `params=${encodeURIComponent(encodeAes(JSON.stringify(body), appSession.zpw_enk))}`,
      {
        params: commonParams(appSession.imei),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': PC_UA,
          Cookie: cookieHeader(appSession.cookies, url),
        },
        timeout: 15_000,
      },
    );
    if (response.data.error_code !== 0 || !response.data.data) return null;
    return JSON.parse(decodeAes(response.data.data, appSession.zpw_enk)) as T;
  } catch (error) {
    console.warn(`[AppApi] ${endpoint} failed:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export async function appGetGroupInfo(groupId: string): Promise<AppGroupData | null> {
  const appSession = loadAppSession();
  if (!appSession) return null;
  const decoded = await encryptedPost<{ data?: { gridInfoMap?: Record<string, AppGroupData> } }>(
    GROUP_DOMAIN,
    '/api/group/getmg-v2',
    { gridVerMap: JSON.stringify({ [groupId]: 0 }) },
    appSession,
  );
  return decoded?.data?.gridInfoMap?.[groupId] ?? null;
}

export async function appGetGroupMembersInfo(uids: string[]): Promise<Map<string, string> | null> {
  const appSession = loadAppSession();
  if (!appSession) return null;
  const result = new Map<string, string>();
  for (let index = 0; index < uids.length; index += 50) {
    const batch = uids.slice(index, index + 50);
    const decoded = await encryptedPost<{
      data?: { profiles?: Record<string, { displayName?: string; zaloName?: string }> };
    }>(
      PROFILE_DOMAIN,
      '/api/social/group/members',
      { friend_pversion_map: batch.map(uid => uid.endsWith('_0') ? uid : `${uid}_0`) },
      appSession,
    );
    for (const uid of batch) {
      const key = uid.endsWith('_0') ? uid : `${uid}_0`;
      const profile = decoded?.data?.profiles?.[key] ?? decoded?.data?.profiles?.[uid];
      const name = profile?.displayName?.trim() || profile?.zaloName?.trim();
      if (name) result.set(uid, name);
    }
  }
  return result;
}

export async function appGetReceivedFriendRequests(count = 200, offset = 0): Promise<any[]> {
  return appGetFriendRequestPayload('/api/friend/recommendsv2/list', { count, offset }, 'recommItems', []);
}

export async function appGetSentFriendRequests(count = 200, offset = 0): Promise<Record<string, any>> {
  return appGetFriendRequestPayload('/api/friend/requested/list', { count, offset }, undefined, {});
}

async function appGetFriendRequestPayload<T>(
  endpoint: string,
  body: unknown,
  key: string | undefined,
  fallback: T,
): Promise<T> {
  const appSession = loadAppSession();
  if (!appSession) return fallback;
  const url = `${FRIEND_DOMAIN}${endpoint}`;
  try {
    const response = await axios.get<{ error_code: number; data?: string }>(url, {
      params: {
        ...commonParams(appSession.imei),
        params: encodeAes(JSON.stringify(body), appSession.zpw_enk),
      },
      headers: { 'User-Agent': PC_UA, Cookie: cookieHeader(appSession.cookies, url) },
      timeout: 15_000,
    });
    if (response.data.error_code !== 0 || !response.data.data) return fallback;
    const parsed = JSON.parse(decodeAes(response.data.data, appSession.zpw_enk)) as { data?: any };
    return (key ? parsed.data?.[key] : parsed.data) ?? fallback;
  } catch (error) {
    console.warn(`[AppApi] ${endpoint} failed:`, error instanceof Error ? error.message : error);
    return fallback;
  }
}
