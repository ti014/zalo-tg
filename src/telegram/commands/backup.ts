import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Context } from 'telegraf';
import type { TgHandlerContext } from '../types.js';
import { config, isOwner } from '../../config.js';
import { settingsStore, store, type AppSettings, type TopicEntry } from '../../store/index.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MSG_MAP_PATH = path.resolve(config.dataDir, 'msg-map.json');
const ENV_PATH = path.resolve(PROJECT_ROOT, '.env');

interface BridgeBackupV1 {
  version: 1;
  createdAt: string;
  note: string;
  topics: TopicEntry[];
  settings: AppSettings;
}

interface BackupFileEntry {
  key: 'msg-map' | 'zalo-credentials' | 'env';
  path: string;
  content: string;
}

interface BridgeBackupV2 {
  version: 2;
  kind: 'state' | 'full';
  createdAt: string;
  note: string;
  topics: TopicEntry[];
  settings: AppSettings;
  files: BackupFileEntry[];
}

type BridgeBackup = BridgeBackupV1 | BridgeBackupV2;

interface ParsedBackup {
  topics: TopicEntry[];
  settings: AppSettings;
  msgMapContent?: string;
  containsSecrets: boolean;
}

function readFileEntry(key: BackupFileEntry['key'], filePath: string): BackupFileEntry | null {
  if (!existsSync(filePath)) return null;
  return {
    key,
    path: path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/'),
    content: readFileSync(filePath, 'utf8'),
  };
}

function createMapBackup(): BridgeBackupV1 {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    note: 'Backup này chỉ chứa topic mapping và UI settings. Không chứa credentials Zalo, token Telegram, hay nội dung tin nhắn.',
    topics: store.all(),
    settings: settingsStore.get(),
  };
}

function createStateBackup(): BridgeBackupV2 {
  const msgMap = readFileEntry('msg-map', MSG_MAP_PATH);
  return {
    version: 2,
    kind: 'state',
    createdAt: new Date().toISOString(),
    note: 'Backup này chứa topic mapping, UI settings và msg-map. Không chứa token Telegram hoặc credentials Zalo.',
    topics: store.all(),
    settings: settingsStore.get(),
    files: msgMap ? [msgMap] : [],
  };
}

function createFullBackup(): BridgeBackupV2 {
  const files = [
    readFileEntry('msg-map', MSG_MAP_PATH),
    readFileEntry('zalo-credentials', config.zalo.credentialsPath),
    readFileEntry('env', ENV_PATH),
  ].filter((entry): entry is BackupFileEntry => entry !== null);

  return {
    version: 2,
    kind: 'full',
    createdAt: new Date().toISOString(),
    note: 'Backup này chứa state đầy đủ, bao gồm credentials/token nếu file tồn tại. Hãy lưu như secret.',
    topics: store.all(),
    settings: settingsStore.get(),
    files,
  };
}

function backupFilePath(kind: BridgeBackupV1['version'] | BridgeBackupV2['kind']): string {
  const backupDir = path.resolve(config.dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(backupDir, `zalo-tg-backup-${kind}-${stamp}.json`);
}

function isTopicEntry(value: unknown): value is TopicEntry {
  const item = value as Partial<TopicEntry> | undefined;
  return Boolean(
    item
      && Number.isFinite(item.topicId)
      && (item.type === 0 || item.type === 1)
      && typeof item.zaloId === 'string'
      && item.zaloId.trim()
      && typeof item.name === 'string'
      && item.name.trim(),
  );
}

function parseBackup(raw: unknown): ParsedBackup {
  const backup = raw as Partial<BridgeBackup> | undefined;
  if (!backup || (backup.version !== 1 && backup.version !== 2) || !Array.isArray(backup.topics)) {
    throw new Error('File backup không hợp lệ hoặc sai version.');
  }

  const topics = backup.topics.filter(isTopicEntry);
  const settings = (backup.settings ?? settingsStore.get()) as AppSettings;

  if (backup.version === 1) {
    return { topics, settings, containsSecrets: false };
  }

  const backupV2 = backup as Partial<BridgeBackupV2>;
  const files = Array.isArray(backupV2.files) ? backupV2.files : [];
  const msgMapContent = files.find((file: BackupFileEntry) => file.key === 'msg-map')?.content;
  const containsSecrets = files.some((file: BackupFileEntry) => file.key === 'env' || file.key === 'zalo-credentials');
  return { topics, settings, msgMapContent, containsSecrets };
}

interface RestoreContextLike {
  message?: {
    reply_to_message?: {
      document?: {
        file_id: string;
        file_size?: number;
      };
    };
  };
  telegram?: {
    getFileLink(fileId: string): Promise<URL>;
  };
}

async function readReplyDocumentJson(ctx: unknown): Promise<ParsedBackup> {
  const restoreCtx = ctx as RestoreContextLike;
  const document = restoreCtx.message?.reply_to_message?.document;
  if (!document) throw new Error('Hãy reply vào file backup .json rồi gõ /restore.');
  if (document.file_size !== undefined && document.file_size > 5 * 1024 * 1024) {
    throw new Error('File backup quá lớn.');
  }
  if (!restoreCtx.telegram) throw new Error('Không đọc được Telegram context.');

  const link = await restoreCtx.telegram.getFileLink(document.file_id);
  const response = await fetch(link);
  if (!response.ok) throw new Error(`Không tải được file backup (${response.status}).`);
  const text = await response.text();
  return parseBackup(JSON.parse(text) as unknown);
}

function parseBackupKind(text: string | undefined): 'map' | 'state' | 'full' {
  const arg = text?.trim().split(/\s+/)[1]?.toLowerCase();
  if (arg === 'full') return 'full';
  if (arg === 'state' || arg === 'all') return 'state';
  return 'map';
}

function canExportSecrets(userId: number | undefined): boolean {
  return config.telegram.ownerIds.size > 0 && isOwner(userId);
}

async function sendBackupDocument(
  ctx: Context,
  backup: BridgeBackup,
  caption: string,
  threadId?: number,
): Promise<void> {
  const kind = backup.version === 1 ? 1 : backup.kind;
  const filePath = backupFilePath(kind);
  writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf8');

  await ctx.telegram.sendDocument(
    config.telegram.groupId,
    { source: createReadStream(filePath), filename: path.basename(filePath) },
    {
      ...(threadId ? { message_thread_id: threadId } : {}),
      caption,
    },
  );
}

export function registerBackupCommands({ bot }: TgHandlerContext): void {
  bot.command('backup', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const kind = parseBackupKind(ctx.message.text);

    if (kind === 'full' && !canExportSecrets(ctx.from?.id)) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        'Backup full chứa secret. Hãy cấu hình TG_OWNER_IDS và chỉ owner mới được chạy lệnh này.',
        threadId ? { message_thread_id: threadId } : {},
      );
      return;
    }

    if (kind === 'full') {
      const backup = createFullBackup();
      await sendBackupDocument(
        ctx,
        backup,
        `Backup full xong: ${backup.topics.length} topic, ${backup.files.length} file state/secret. Lưu file này như secret.`,
        threadId,
      );
      return;
    }

    if (kind === 'state') {
      const backup = createStateBackup();
      await sendBackupDocument(
        ctx,
        backup,
        `Backup state xong: ${backup.topics.length} topic, ${backup.files.length} file runtime. Không chứa credentials.`,
        threadId,
      );
      return;
    }

    const backup = createMapBackup();
    await sendBackupDocument(
      ctx,
      backup,
      `Backup map xong: ${backup.topics.length} topic. File này không chứa credentials.`,
      threadId,
    );
  });

  bot.command('restore', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;

    try {
      const backup = await readReplyDocumentJson(ctx);
      const restoredCount = store.replaceAll(backup.topics);
      settingsStore.replace(backup.settings);
      if (backup.msgMapContent !== undefined) {
        mkdirSync(path.dirname(MSG_MAP_PATH), { recursive: true });
        writeFileSync(MSG_MAP_PATH, backup.msgMapContent, 'utf8');
      }

      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `Restore xong: ${restoredCount} topic${backup.msgMapContent !== undefined ? ', kèm msg-map' : ''}.${backup.containsSecrets ? ' File có secret nhưng restore không tự ghi .env/credentials.' : ''}`,
        threadId ? { message_thread_id: threadId } : {},
      );
    } catch (err) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `Restore thất bại: ${err instanceof Error ? err.message : String(err)}`,
        threadId ? { message_thread_id: threadId } : {},
      );
    }
  });
}
