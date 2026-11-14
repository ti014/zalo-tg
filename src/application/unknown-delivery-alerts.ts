import type { DeliveryRecord, DeliveryRepository, UnknownDeliveryCursor } from '../infrastructure/database/delivery-repository.js';

/** In-memory cursor: open problems are announced again after restart. */
export function createUnknownDeliveryCheck(
  repository: Pick<DeliveryRepository, 'listUnknownAfter'>,
  send: (text: string) => Promise<unknown>,
  label: (delivery: DeliveryRecord) => string,
): () => Promise<void> {
  let cursor: UnknownDeliveryCursor = { updatedAt: 0, id: '' };
  let running = false;
  const header = 'Delivery UNKNOWN đang chặn các tin phía sau trong cùng hội thoại:\n';
  const footer = '\nKiểm tra đích rồi dùng /queue sent|retry|dlq <delivery-id>.';
  return async () => {
    if (running) return;
    running = true;
    try {
      const deliveries = repository.listUnknownAfter(cursor);
      let text = header;
      let last: DeliveryRecord | undefined;
      const flush = async () => {
        if (!last) return;
        await send(text + footer);
        cursor = { updatedAt: last.updatedAt, id: last.id };
      };
      for (const delivery of deliveries) {
        const name = Array.from(label(delivery)).slice(0, 120).join('').replace(/[\r\n]/g, ' ');
        const line = `${delivery.destination === 'telegram' ? 'Zalo→TG' : 'TG→Zalo'} ${name}: /queue detail ${delivery.id}\n`;
        if (text.length + line.length + footer.length > 4096) {
          await flush();
          text = header;
        }
        text += line;
        last = delivery;
      }
      await flush();
    } finally {
      running = false;
    }
  };
}
