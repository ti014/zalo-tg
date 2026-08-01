/** QR login through Zalo's PC-App API, adapted to the current client hooks. */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { statSync, unlinkSync, writeFileSync } from 'node:fs';
import axios, { type AxiosInstance } from 'axios';
import { Zalo } from 'zca-js';
import { imageSizeFromFile } from 'image-size/fromFile';
import { config } from '../config.js';
import { writePrivateJsonFileSync } from '../utils/privateFile.js';
import { createSharedTempPath, prepareSharedTempFile } from '../utils/sharedTemp.js';
import type { ZaloAPI } from './types.js';
import type { QRLoginHooks } from './client.js';

const AUTH_DOMAIN = 'https://wpa.zaloapp.com';
const API_TYPE = 30;
const API_VERSION = 671;
const PC_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ZaloPC/23.12.1 Chrome/102.0.5005.167 Electron/19.1.9 Safari/537.36';

export function encodeAppAes(plaintext: string, encodedKey: string): string {
  const key = Buffer.from(encodedKey, 'base64');
  const algorithm = key.length === 16 ? 'aes-128-cbc' : key.length === 24 ? 'aes-192-cbc' : 'aes-256-cbc';
  const cipher = crypto.createCipheriv(algorithm, key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

export function buildAppSignKey(endpoint: string, params: Record<string, unknown>): string {
  const seed = 'zsecure' + endpoint + Object.keys(params).sort().map(key => String(params[key])).join('');
  return crypto.createHash('md5').update(seed, 'utf8').digest('hex');
}

function authParams(body: Record<string, unknown>, endpoint: string): Record<string, string> {
  const params: Record<string, unknown> = {
    ...body,
    type: API_TYPE,
    client_version: API_VERSION,
  };
  params.signkey = buildAppSignKey(endpoint, params);
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]));
}

interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  maxAge?: number;
  sameSite: string;
  creation: string;
  lastAccessed: string;
}

class CookieJar {
  private readonly cookies = new Map<string, CookieRecord>();

  ingest(headers: string[], originUrl: string): void {
    const originHost = new URL(originUrl).hostname;
    for (const raw of headers) {
      const parts = raw.split(';').map(part => part.trim());
      const separator = parts[0]?.indexOf('=') ?? -1;
      if (separator < 0) continue;
      const name = parts[0]!.slice(0, separator).trim();
      const value = parts[0]!.slice(separator + 1).trim();
      let domain = originHost;
      let cookiePath = '/';
      let secure = false;
      let httpOnly = false;
      let maxAge: number | undefined;
      let sameSite = 'lax';
      for (const attribute of parts.slice(1)) {
        const lower = attribute.toLowerCase();
        if (lower.startsWith('domain=')) domain = attribute.slice(7).replace(/^\./, '');
        else if (lower.startsWith('path=')) cookiePath = attribute.slice(5);
        else if (lower.startsWith('max-age=')) maxAge = Number.parseInt(attribute.slice(8), 10) || undefined;
        else if (lower.startsWith('samesite=')) sameSite = attribute.slice(9).toLowerCase();
        else if (lower === 'secure') secure = true;
        else if (lower === 'httponly') httpOnly = true;
      }
      const now = new Date().toISOString();
      this.cookies.set(`${domain}::${name}`, {
        name, value, domain, path: cookiePath, secure, httpOnly, maxAge, sameSite,
        creation: now, lastAccessed: now,
      });
    }
  }

  headerFor(url: string): string {
    const parsed = new URL(url);
    return [...this.cookies.values()]
      .filter(cookie => (
        (parsed.hostname.endsWith(cookie.domain) || parsed.hostname === cookie.domain)
        && (!cookie.secure || parsed.protocol === 'https:')
      ))
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  toZcaFormat(): Record<string, unknown>[] {
    return [...this.cookies.values()].map(cookie => ({
      key: cookie.name,
      value: cookie.value,
      domain: cookie.domain.includes('zaloapp.com') ? 'chat.zalo.me' : cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      hostOnly: false,
      creation: cookie.creation,
      lastAccessed: cookie.lastAccessed,
      ...(cookie.maxAge === undefined ? {} : { maxAge: cookie.maxAge }),
      sameSite: cookie.sameSite,
    }));
  }

  toRawPairs(): Array<{ name: string; value: string; domain: string }> {
    return [...this.cookies.values()].map(({ name, value, domain }) => ({ name, value, domain }));
  }

  get size(): number { return this.cookies.size; }
}

function createSession(jar: CookieJar): AxiosInstance {
  const session = axios.create({
    headers: { 'User-Agent': PC_UA, Accept: 'application/json' },
    timeout: 20_000,
    maxRedirects: 5,
  });
  session.interceptors.request.use(request => {
    const url = `${request.baseURL ?? ''}${request.url ?? ''}`;
    const header = jar.headerFor(url);
    if (header) request.headers.Cookie = header;
    return request;
  });
  session.interceptors.response.use(response => {
    const raw = response.headers['set-cookie'];
    const headers = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (headers.length > 0 && response.config.url) jar.ingest(headers, response.config.url);
    return response;
  });
  return session;
}

let activeController: AbortController | null = null;

export function cancelActiveAppLogin(): boolean {
  if (!activeController) return false;
  activeController.abort();
  activeController = null;
  return true;
}

export interface AppLoginHooks extends QRLoginHooks {
  onLoginData?: (data: Record<string, unknown>) => Promise<void>;
}

export async function triggerAppLogin(hooks: AppLoginHooks = {}): Promise<ZaloAPI> {
  const controller = new AbortController();
  let qrPath: string | undefined;
  activeController?.abort();
  activeController = controller;
  const ensureActive = (): void => {
    if (controller.signal.aborted) throw new Error('App QR login cancelled');
  };

  try {
    const jar = new CookieJar();
    const session = createSession(jar);
    const imei = `${crypto.randomUUID()}-${crypto.createHash('md5').update(PC_UA).digest('hex')}`;
    const host = os.hostname() || 'ZaloPCClient';
    const requestQuery = new URLSearchParams(authParams({
      language: 'vi',
      client_time: String(Math.floor(Date.now() / 1_000)),
      imei,
      computer_name: host,
      logged_uids: '[]',
    }, 'reqqr'));
    const qrResponse = await fetch(
      `${AUTH_DOMAIN}/api/login/reqqr?${requestQuery.toString()}`,
      { headers: { 'User-Agent': PC_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
    );
    if (!qrResponse.ok) throw new Error(`PC-App QR request returned HTTP ${qrResponse.status}`);
    const qrBody = await qrResponse.json() as Record<string, unknown>;
    if (qrBody.error_code !== 0) throw new Error(`PC-App QR request failed: ${JSON.stringify(qrBody)}`);
    const inner = (qrBody.data as Record<string, unknown> | undefined) ?? {};
    const base64Qr = String(inner.base64_qr ?? '');
    const tokenId = String(inner.token_id ?? '');
    const pollUrl = String(inner.chk_wait_cfirm ?? '');
    if (!base64Qr && !tokenId) throw new Error('PC-App QR response did not contain QR data.');

    qrPath = createSharedTempPath('zalo-tg-app', 'zalo-app-qr', 'png');
    if (base64Qr) writeFileSync(qrPath, Buffer.from(base64Qr, 'base64'));
    else {
      const qrcode = await import('qrcode');
      await qrcode.toFile(qrPath, tokenId, { width: 400, margin: 2 });
    }
    prepareSharedTempFile(qrPath);
    await hooks.onQRReady?.(qrPath, tokenId);
    ensureActive();
    if (!pollUrl) throw new Error('PC-App QR response did not contain a polling URL.');

    let confirmed = false;
    for (let attempt = 0; attempt < 90 && !confirmed; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      ensureActive();
      try {
        const poll = await session.get<{ error_code?: number; errorCode?: number }>(pollUrl, {
          timeout: 10_000,
          signal: controller.signal,
        });
        const code = poll.data.error_code ?? poll.data.errorCode ?? -1;
        if (code === 0) confirmed = true;
      } catch { /* transient polling error */ }
    }
    if (!confirmed) throw new Error('PC-App QR login timed out after three minutes.');
    await hooks.onScanned?.('Zalo');

    const loginInfo = await session.get<{
      error_code: number;
      error_message?: string;
      data?: Record<string, unknown>;
    }>(`${AUTH_DOMAIN}/api/login/getLoginInfo`, {
      signal: controller.signal,
      params: authParams({ imei, computer_name: host, language: 'vi', ts: String(Date.now()) }, 'getlogininfo'),
    });
    if (loginInfo.data.error_code !== 0) {
      throw new Error(`PC-App login info failed: ${loginInfo.data.error_message ?? loginInfo.data.error_code}`);
    }
    const loginData = loginInfo.data.data ?? {};
    const displayName = String(loginData.send2me_name ?? loginData.name ?? loginData.zaloName ?? loginData.uid ?? 'Zalo');
    await hooks.onLoginData?.(loginData);

    const credentials = { imei, cookie: jar.toZcaFormat(), userAgent: PC_UA };
    writePrivateJsonFileSync(config.zalo.credentialsPath, credentials);
    const zpwEnk = String(loginData.zpw_enk ?? '');
    if (zpwEnk) {
      writePrivateJsonFileSync(
        path.join(path.dirname(config.zalo.credentialsPath), 'app-session.json'),
        { zpw_enk: zpwEnk, dkey: String(loginData.dkey ?? '') || undefined, imei, cookies: jar.toRawPairs() },
      );
    }

    const zalo = new Zalo({
      logging: false,
      checkUpdate: false,
      selfListen: true,
      imageMetadataGetter: async (filePath: string) => {
        try {
          const { width, height } = await imageSizeFromFile(filePath);
          return { width: width ?? 0, height: height ?? 0, size: statSync(filePath).size };
        } catch { return null; }
      },
    });
    const api = await zalo.login(credentials as Parameters<typeof zalo.login>[0]) as ZaloAPI;
    await hooks.onSuccess?.();
    return api;
  } finally {
    if (activeController === controller) activeController = null;
    if (qrPath) {
      try { unlinkSync(qrPath); } catch { /* Best-effort cleanup. */ }
    }
  }
}
