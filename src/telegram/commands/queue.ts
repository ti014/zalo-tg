import { config } from '../../config.js';
import { escapeHtml } from '../../utils/format.js';
import type { TgHandlerContext } from '../types.js';

const PROBLEM_LIMIT = 10;

function formatTime(timestamp: number | null): string {
  return timestamp === null ? '-' : new Date(timestamp).toISOString();
}

export function registerQueueCommand({ bot, deliveryRepository }: TgHandlerContext): void {
  bot.command('queue', async ctx => {
    if (ctx.chat.id !== config.telegram.groupId || !deliveryRepository) return;
    const threadId = 'message_thread_id' in ctx.message
      ? ctx.message.message_thread_id
      : undefined;
    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const action = args[0]?.toLowerCase();
    const deliveryId = args[1];

    if (action === 'part') {
      const partAction = args[1]?.toLowerCase();
      const multipartDeliveryId = args[2];
      const partNo = Number(args[3]);
      if (
        (partAction !== 'sent' && partAction !== 'retry')
        || !multipartDeliveryId
        || !Number.isSafeInteger(partNo)
        || partNo < 1
      ) {
        await ctx.reply(
          'Cú pháp: /queue part sent <delivery-id> <part-no> <telegram-message-id> [lý do]\n'
          + '/queue part retry <delivery-id> <part-no> [lý do]',
        );
        return;
      }
      const providerMessageId = partAction === 'sent' ? args[4] : undefined;
      const reasonStart = partAction === 'sent' ? 5 : 4;
      try {
        const updatedPart = deliveryRepository.resolveTelegramMultipartPart(
          multipartDeliveryId,
          partNo,
          Date.now(),
          partAction,
          {
            actorTelegramUserId: ctx.from.id,
            ...(providerMessageId ? { providerMessageId } : {}),
            ...(args.length > reasonStart
              ? { reason: args.slice(reasonStart).join(' ') }
              : {}),
          },
        );
        await ctx.reply(
          `Multipart <code>${escapeHtml(updatedPart.deliveryId)}</code> `
          + `part ${updatedPart.partNo} → <b>${updatedPart.status}</b>`,
          {
            parse_mode: 'HTML',
            ...(threadId ? { message_thread_id: threadId } : {}),
          },
        );
      } catch (error) {
        await ctx.reply(
          `Không thể xử lý multipart part: `
          + (error instanceof Error ? error.message : String(error)),
        );
      }
      return;
    }

    if (action === 'detail' && deliveryId) {
      const delivery = deliveryRepository.getById(deliveryId);
      if (!delivery) {
        await ctx.reply('Không tìm thấy delivery.');
        return;
      }
      const attempts = deliveryRepository.listAttempts(delivery.id, 10);
      const receipts = deliveryRepository.listProviderReceipts(delivery.id, 50);
      const skipAudit = deliveryRepository.getSkipAudit(delivery.id);
      const multipartManifest = deliveryRepository.getTelegramMultipartManifest(delivery.id);
      const multipartParts = deliveryRepository.listTelegramMultipartParts(delivery.id);
      const operatorActions = deliveryRepository.listOperatorActions(delivery.id, 10);
      const attemptText = attempts.length > 0
        ? attempts.map(attempt =>
          `#${attempt.attemptNo} ${attempt.outcome} start=${formatTime(attempt.startedAt)} `
          + `finish=${formatTime(attempt.finishedAt)}`
          + (attempt.providerMessageId
            ? ` provider=${escapeHtml(attempt.providerMessageId)}`
            : '')
          + (attempt.errorCode ? ` error=${escapeHtml(attempt.errorCode)}` : ''),
        ).join('\n')
        : 'Chưa có attempt.';
      const receiptText = receipts.length > 0
        ? receipts.map(receipt =>
          `#${receipt.attemptNo} ${receipt.provider}:${receipt.receiptKind}`
          + `[${receipt.ordinal}] id=${escapeHtml(receipt.providerMessageId)}`
          + (receipt.isPrimary ? ' primary' : '')
          + ` at=${formatTime(receipt.receivedAt)}`,
        ).join('\n')
        : 'Chưa có provider receipt.';
      const skipText = skipAudit
        ? `${escapeHtml(skipAudit.reasonCode)} at=${formatTime(skipAudit.createdAt)} `
          + escapeHtml(skipAudit.reason)
        : '-';
      const multipartText = multipartManifest
        ? `source=${escapeHtml(multipartManifest.sourceSha256)} `
          + `bytes=${multipartManifest.sourceByteSize} `
          + `partSize=${multipartManifest.partSizeBytes}\n`
          + multipartParts.map(part =>
            `#${part.partNo} ${part.status} attempts=${part.attempts}`
            + (part.providerMessageId
              ? ` provider=${escapeHtml(part.providerMessageId)}`
              : '')
            + (part.lastErrorCode
              ? ` error=${escapeHtml(part.lastErrorCode)}`
              : ''),
          ).join('\n')
        : '-';
      const operatorText = operatorActions.length > 0
        ? operatorActions.map(entry =>
          `${entry.action} from=${entry.previousStatus} actor=${entry.actorTelegramUserId} `
          + `at=${formatTime(entry.createdAt)}`
          + (entry.reason ? ` reason=${escapeHtml(entry.reason)}` : ''),
        ).join('\n')
        : 'Chưa có operator action.';
      await ctx.reply(
        `<b>Delivery detail</b>\n`
        + `ID: <code>${escapeHtml(delivery.id)}</code>\n`
        + `Source: ${delivery.source}:${escapeHtml(delivery.sourceEventKey)}\n`
        + `Destination: ${delivery.destination}\n`
        + `Conversation: ${escapeHtml(delivery.conversationKey)}\n`
        + `Event: ${escapeHtml(delivery.eventType)}\n`
        + `Status: <b>${delivery.status}</b>, attempts=${delivery.attempts}\n`
        + `Received: ${formatTime(delivery.receivedAt)}\n`
        + `Updated: ${formatTime(delivery.updatedAt)}\n`
        + `Provider ID: ${escapeHtml(delivery.providerMessageId ?? '-')}\n`
        + `Last error: ${escapeHtml(delivery.lastErrorCode ?? '-')} `
        + `${escapeHtml((delivery.lastErrorMessage ?? '').slice(0, 300))}\n\n`
        + `<b>Attempts</b>\n${attemptText}\n\n`
        + `<b>Provider receipts</b>\n${receiptText}\n\n`
        + `<b>Skip audit</b>\n${skipText}\n\n`
        + `<b>Multipart</b>\n${multipartText}\n\n`
        + `<b>Operator actions</b>\n${operatorText}`,
        {
          parse_mode: 'HTML',
          ...(threadId ? { message_thread_id: threadId } : {}),
        },
      );
      return;
    }

    if (action && deliveryId) {
      try {
        const operator = {
          actorTelegramUserId: ctx.from.id,
          ...(args.length > 2 ? { reason: args.slice(2).join(' ') } : {}),
        };
        const now = Date.now();
        const updated = action === 'retry'
          ? deliveryRepository.requeueProblem(deliveryId, now, operator)
          : action === 'sent'
            ? deliveryRepository.resolveProblemAsSent(deliveryId, now, operator)
            : action === 'dlq'
              ? deliveryRepository.resolveProblemAsDlq(deliveryId, now, operator)
              : undefined;
        if (!updated) {
          await ctx.reply('Cú pháp: /queue [detail|retry|sent|dlq] <delivery-id> [lý do]');
          return;
        }
        await ctx.reply(`Delivery <code>${escapeHtml(updated.id)}</code> → <b>${updated.status}</b>`, {
          parse_mode: 'HTML',
          ...(threadId ? { message_thread_id: threadId } : {}),
        });
        return;
      } catch (error) {
        await ctx.reply(`Không thể xử lý delivery: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    const counts = deliveryRepository.statusCounts();
    const totalProblems = deliveryRepository.problemCount();
    const totalPages = Math.max(1, Math.ceil(totalProblems / PROBLEM_LIMIT));
    const requestedPage = action && /^\d+$/.test(action) ? Number(action) : 1;
    const page = Math.min(Math.max(1, requestedPage), totalPages);
    const problems = deliveryRepository.listProblems(PROBLEM_LIMIT, (page - 1) * PROBLEM_LIMIT);
    const countText = counts.length > 0
      ? counts.map(row => `${row.status}=${row.count}`).join(', ')
      : 'trống';
    const problemText = problems.length > 0
      ? problems.map(delivery =>
        `<code>${escapeHtml(delivery.id)}</code> ${delivery.status} `
        + `${escapeHtml(delivery.conversationKey)} attempts=${delivery.attempts}`
        + (delivery.lastErrorCode
          ? ` error=${escapeHtml(delivery.lastErrorCode)}:${escapeHtml(
            (delivery.lastErrorMessage ?? '').slice(0, 160),
          )}`
          : ''),
      ).join('\n')
      : 'Không có delivery cần xử lý.';

    await ctx.reply(
      `<b>Durable queue</b>\n${escapeHtml(countText)}\n`
      + `Problems: ${totalProblems}, page ${page}/${totalPages}\n\n${problemText}`,
      {
        parse_mode: 'HTML',
        ...(threadId ? { message_thread_id: threadId } : {}),
      },
    );
  });
}
