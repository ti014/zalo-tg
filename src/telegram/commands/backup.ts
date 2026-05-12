import { createReadStream, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import type { TgHandlerContext } from '../types.js';
import { config } from '../../config.js';
import { settingsStore, store, type AppSettings, type TopicEntry } from '../../store/index.js';

interface BridgeBackup {
  version: 1;
  createdAt: string;
  note: string;
  topics: TopicEntry[];
  settings: AppSettings;
}

function createBackup(): BridgeBackup {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    note: 'Backup này chỉ chứa topic mapping và UI settings. Không chứa credentials Zalo, token Telegram, hay nội dung tin nhắn.',
    topics: store.all(),
    settings: settingsStore.get(),
  };
}

function backupFilePath(): string {
  const backupDir = path.resolve(config.dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(backupDir, `zalo-tg-backup-${stamp}.json`);
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

function parseBackup(raw: unknown): BridgeBackup {
  const backup = raw as Partial<BridgeBackup> | undefined;
  if (!backup || backup.version !== 1 || !Array.isArray(backup.topics)) {
    throw new Error('File backup không hợp lệ hoặc sai version.');
  }
  const topics = backup.topics.filter(isTopicEntry);
  return {
    version: 1,
    createdAt: typeof backup.createdAt === 'string' ? backup.createdAt : new Date().toISOString(),
    note: typeof backup.note === 'string' ? backup.note : '',
    topics,
    settings: (backup.settings ?? settingsStore.get()) as AppSettings,
  };
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

async function readReplyDocumentJson(ctx: unknown): Promise<BridgeBackup> {
  const restoreCtx = ctx as RestoreContextLike;
  const document = restoreCtx.message?.reply_to_message?.document;
  if (!document) throw new Error('Hãy reply vào file backup .json rồi gõ /restore.');
  if (document.file_size !== undefined && document.file_size > 2 * 1024 * 1024) {
    throw new Error('File backup quá lớn.');
  }
  if (!restoreCtx.telegram) throw new Error('Không đọc được Telegram context.');

  const link = await restoreCtx.telegram.getFileLink(document.file_id);
  const response = await fetch(link);
  if (!response.ok) throw new Error(`Không tải được file backup (${response.status}).`);
  const text = await response.text();
  return parseBackup(JSON.parse(text) as unknown);
}

export function registerBackupCommands({ bot }: TgHandlerContext): void {
  bot.command('backup', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;

    const backup = createBackup();
    const filePath = backupFilePath();
    writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf8');

    await ctx.telegram.sendDocument(
      config.telegram.groupId,
      { source: createReadStream(filePath), filename: path.basename(filePath) },
      {
        ...(threadId ? { message_thread_id: threadId } : {}),
        caption: `Backup xong: ${backup.topics.length} topic. File này không chứa credentials.`,
      },
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

      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `Restore xong: ${restoredCount} topic. Nếu topic Telegram đã bị xóa, bot sẽ tự tạo lại khi có tin mới.`,
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
