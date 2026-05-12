import type { TopicEntry } from '../../store/index.js';
import { escapeHtml } from '../../utils/format.js';

export interface MenuViewModel {
  zaloConnected: boolean;
  topicCount: number;
  groupCount: number;
  dmCount: number;
  compactMode: boolean;
}

export interface StatusViewModel extends MenuViewModel {
  uptime: string;
  accountName?: string;
  detailed: boolean;
  generatedAt: string;
  rateLimitInfo?: string;
}

function connectionLabel(connected: boolean): string {
  return connected ? '<b>đã kết nối</b>' : '<b>chưa kết nối</b>';
}

export function renderMenu(model: MenuViewModel): string {
  if (model.compactMode) {
    return `<b>Bảng điều khiển cầu nối</b>\n\n` +
      `Zalo: ${connectionLabel(model.zaloConnected)}\n` +
      `Topic: <b>${model.topicCount}</b> (${model.groupCount} nhóm, ${model.dmCount} chat riêng)\n` +
      `Chế độ: tự host`;
  }

  return `<b>Bảng điều khiển cầu nối</b>\n\n` +
    `<b>Kết nối</b>\n` +
    `Zalo: ${connectionLabel(model.zaloConnected)}\n\n` +
    `<b>Dữ liệu</b>\n` +
    `Topic: <b>${model.topicCount}</b>\n` +
    `Nhóm: <b>${model.groupCount}</b>\n` +
    `Chat riêng: <b>${model.dmCount}</b>\n\n` +
    `<b>Vận hành</b>\n` +
    `Chế độ: tự host`;
}

export function renderStatus(model: StatusViewModel): string {
  const accountLine = model.accountName
    ? `Tài khoản: <b>${escapeHtml(model.accountName)}</b>\n`
    : '';

  if (model.compactMode && !model.detailed) {
    return `<b>Trạng thái cầu nối</b>\n\n` +
      `Zalo: ${connectionLabel(model.zaloConnected)}\n` +
      `Thời gian chạy: <code>${model.uptime}</code>\n` +
      `Topic: <b>${model.topicCount}</b> (${model.groupCount} nhóm, ${model.dmCount} chat riêng)`;
  }

  return `<b>Trạng thái cầu nối</b>\n\n` +
    `<b>Kết nối</b>\n` +
    `Zalo: ${connectionLabel(model.zaloConnected)}\n` +
    accountLine +
    `\n<b>Vận hành</b>\n` +
    `Thời gian chạy: <code>${model.uptime}</code>\n` +
    `Cập nhật: <code>${escapeHtml(model.generatedAt)}</code>\n\n` +
    `<b>Dữ liệu</b>\n` +
    `Topic: <b>${model.topicCount}</b>\n` +
    `Nhóm: <b>${model.groupCount}</b>\n` +
    `Chat riêng: <b>${model.dmCount}</b>` +
    (model.rateLimitInfo ? `\n\n<b>Rate limit</b>\n<code>${escapeHtml(model.rateLimitInfo)}</code>` : '');
}

export function renderSettings(settings: { compactMode: boolean; statusDetails: boolean; topicActions: boolean }): string {
  return `<b>Cài đặt giao diện</b>\n\n` +
    `Giao diện gọn: <b>${settings.compactMode ? 'bật' : 'tắt'}</b>\n` +
    `Chi tiết trạng thái: <b>${settings.statusDetails ? 'bật' : 'tắt'}</b>\n` +
    `Nút trong topic: <b>${settings.topicActions ? 'bật' : 'tắt'}</b>\n\n` +
    `<i>Tự host: không tự làm mới, không gắn giao diện vào tin nhắn chuyển tiếp.</i>`;
}

export function renderHelp(): string {
  return `<b>Hướng dẫn</b>\n\n` +
    `<b>Lệnh chính</b>\n` +
    `/menu - mở bảng điều khiển\n` +
    `/search &lt;tên|số điện thoại&gt; - tìm bạn bè hoặc nhóm Zalo\n` +
    `/status - xem trạng thái cầu nối\n` +
    `/login - đăng nhập Zalo bằng QR\n\n` +
    `<b>Lệnh nâng cao vẫn dùng được</b>\n` +
    `/settings - cài đặt giao diện\n` +
    `/topic info - xem ánh xạ topic hiện tại\n` +
    `/topic list - danh sách ánh xạ\n` +
    `/topic delete - xóa ánh xạ topic hiện tại\n` +
    `/addfriend &lt;số điện thoại&gt; - tìm và kết bạn\n` +
    `/friendrequests - xem lời mời\n` +
    `/recall - thu hồi tin nhắn đã gửi sang Zalo\n` +
    `  Cách dùng: reply vào đúng tin mình đã gửi từ Telegram sang Zalo, rồi gõ /recall.\n` +
    `/members - xem thành viên nhóm Zalo cho topic hiện tại\n` +
    `/kick &lt;uid|tên&gt; - kick thành viên Zalo (owner)\n` +
    `/backup - xuất topic map và cài đặt\n` +
    `/backup state - xuất topic map, cài đặt, msg-map\n` +
    `/backup full - xuất full state kèm secret (owner only)\n` +
    `/restore - reply vào file backup để khôi phục`;
}

export function renderTopicCard(entry: TopicEntry): string {
  return `<b>Topic</b>\n\n` +
    `Tên: <b>${escapeHtml(entry.name)}</b>\n` +
    `Loại: <b>${entry.type === 1 ? 'nhóm' : 'chat riêng'}</b>\n` +
    `Mã Zalo: <code>${escapeHtml(entry.zaloId)}</code>\n` +
    `Mã topic: <code>${entry.topicId}</code>`;
}

export function renderDeleteTopicConfirm(entry: TopicEntry): string {
  return `<b>Xác nhận xóa ánh xạ</b>\n\n` +
    `Tên: <b>${escapeHtml(entry.name)}</b>\n` +
    `Mã topic: <code>${entry.topicId}</code>\n\n` +
    `Chỉ xóa ánh xạ cục bộ. Chat Zalo không bị ảnh hưởng.`;
}
