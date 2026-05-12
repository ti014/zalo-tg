import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { config } from '../config.js';

export interface TelegramUiSettings {
  compactMode: boolean;
  statusDetails: boolean;
  topicActions: boolean;
}

export interface AppSettings {
  telegramUi: TelegramUiSettings;
}

const DEFAULT_SETTINGS: AppSettings = {
  telegramUi: {
    compactMode: true,
    statusDetails: false,
    topicActions: true,
  },
};

const settingsPath = path.resolve(config.dataDir, 'settings.json');
let settingsData = loadSettings();

function mergeSettings(raw: Partial<AppSettings>): AppSettings {
  return {
    telegramUi: {
      ...DEFAULT_SETTINGS.telegramUi,
      ...(raw.telegramUi ?? {}),
    },
  };
}

function loadSettings(): AppSettings {
  if (!existsSync(settingsPath)) return DEFAULT_SETTINGS;
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<AppSettings>;
    return mergeSettings(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(data: AppSettings): void {
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf8');
}

export const settingsStore = {
  get(): AppSettings {
    return settingsData;
  },

  replace(raw: Partial<AppSettings>): AppSettings {
    settingsData = mergeSettings(raw);
    persistSettings(settingsData);
    return settingsData;
  },

  updateTelegramUi(patch: Partial<TelegramUiSettings>): AppSettings {
    settingsData = mergeSettings({
      ...settingsData,
      telegramUi: {
        ...settingsData.telegramUi,
        ...patch,
      },
    });
    persistSettings(settingsData);
    return settingsData;
  },

  toggleTelegramUi(key: keyof TelegramUiSettings): AppSettings {
    return this.updateTelegramUi({ [key]: !settingsData.telegramUi[key] });
  },
};
