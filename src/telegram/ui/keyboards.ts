import type { TopicEntry } from '../../store/index.js';
import { buildTopicUrl } from '../helpers.js';

export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineButton[][];
}

export function menuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: 'Trạng thái', callback_data: 'ui:s' },
        { text: 'Tìm kiếm', callback_data: 'ui:search' },
      ],
      [
        { text: 'Topic', callback_data: 'ui:topics' },
        { text: 'Lời mời', callback_data: 'ui:requests' },
      ],
      [
        { text: 'Cài đặt', callback_data: 'ui:set' },
        { text: 'Hướng dẫn', callback_data: 'ui:help' },
      ],
    ],
  };
}

export function statusKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: 'Làm mới', callback_data: 'ui:sr' },
        { text: 'Menu', callback_data: 'ui:h' },
      ],
      [
        { text: 'Cài đặt', callback_data: 'ui:set' },
      ],
    ],
  };
}

export function settingsKeyboard(settings: { compactMode: boolean; statusDetails: boolean; topicActions: boolean }): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: `Giao diện gọn: ${settings.compactMode ? 'bật' : 'tắt'}`, callback_data: 'ui:st:c' },
      ],
      [
        { text: `Chi tiết trạng thái: ${settings.statusDetails ? 'bật' : 'tắt'}`, callback_data: 'ui:st:d' },
      ],
      [
        { text: `Nút trong topic: ${settings.topicActions ? 'bật' : 'tắt'}`, callback_data: 'ui:st:t' },
      ],
      [
        { text: 'Menu', callback_data: 'ui:h' },
      ],
    ],
  };
}

export function helpKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: 'Menu', callback_data: 'ui:h' }]],
  };
}

export function topicKeyboard(entry: TopicEntry): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: 'Mở topic', url: buildTopicUrl(entry.topicId) }],
      [
        { text: 'Xóa ánh xạ', callback_data: `ui:tc:${entry.topicId}` },
        { text: 'Menu', callback_data: 'ui:h' },
      ],
    ],
  };
}

export function confirmDeleteTopicKeyboard(topicId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: 'Xác nhận xóa', callback_data: `ui:td:${topicId}` },
        { text: 'Hủy', callback_data: `ui:t:${topicId}` },
      ],
    ],
  };
}
