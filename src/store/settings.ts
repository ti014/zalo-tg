import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { writeJsonAtomicSync } from '../infrastructure/files/atomic-file.js';
import { shadowSettingsReplace } from '../infrastructure/database/shadow-state.js';

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
type LoadStatus = 'loaded' | 'missing' | 'invalid';
let loadStatus: LoadStatus = 'missing';
let loadFailure: Error | undefined;
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
  loadFailure = undefined;
  if (!existsSync(settingsPath)) {
    loadStatus = 'missing';
    return DEFAULT_SETTINGS;
  }
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<AppSettings>;
    const loaded = mergeSettings(raw);
    loadStatus = 'loaded';
    return loaded;
  } catch (error) {
    loadStatus = 'invalid';
    loadFailure = new Error(`Cannot load ${settingsPath}; SQLite recovery is required.`, { cause: error });
    console.error('[settingsStore] Legacy settings file is invalid; deferring to SQLite recovery:', loadFailure);
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(data: AppSettings): void {
  writeJsonAtomicSync(settingsPath, data, 2);
}

export const settingsStore = {
  get(): AppSettings {
    return settingsData;
  },

  replace(raw: Partial<AppSettings>): AppSettings {
    settingsData = mergeSettings(raw);
    persistSettings(settingsData);
    loadStatus = 'loaded';
    loadFailure = undefined;
    shadowSettingsReplace(settingsData);
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
    shadowSettingsReplace(settingsData);
    return settingsData;
  },

  toggleTelegramUi(key: keyof TelegramUiSettings): AppSettings {
    return this.updateTelegramUi({ [key]: !settingsData.telegramUi[key] });
  },

  loadState(): { status: LoadStatus; error?: Error } {
    return { status: loadStatus, ...(loadFailure ? { error: loadFailure } : {}) };
  },
};
