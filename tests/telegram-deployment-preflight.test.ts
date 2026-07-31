import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTelegramDeploymentCapabilities,
} from '../src/telegram/deployment-preflight.js';

test('Telegram deployment preflight accepts a fully privileged forum administrator', () => {
  assert.doesNotThrow(() => assertTelegramDeploymentCapabilities(
    { type: 'supergroup', is_forum: true },
    {
      status: 'administrator',
      can_manage_topics: true,
      can_delete_messages: true,
      can_pin_messages: true,
    },
  ));
  assert.doesNotThrow(() => assertTelegramDeploymentCapabilities(
    { type: 'supergroup', is_forum: true },
    { status: 'creator' },
  ));
});

test('Telegram deployment preflight rejects a non-forum or non-supergroup target', () => {
  assert.throws(
    () => assertTelegramDeploymentCapabilities(
      { type: 'group', is_forum: false },
      { status: 'creator' },
    ),
    (error: unknown) => (error as { code?: string }).code === 'TELEGRAM_SUPERGROUP_REQUIRED',
  );
  assert.throws(
    () => assertTelegramDeploymentCapabilities(
      { type: 'supergroup', is_forum: false },
      { status: 'creator' },
    ),
    (error: unknown) => (error as { code?: string }).code === 'TELEGRAM_FORUM_REQUIRED',
  );
});

test('Telegram deployment preflight reports every missing administrator permission', () => {
  assert.throws(
    () => assertTelegramDeploymentCapabilities(
      { type: 'supergroup', is_forum: true },
      {
        status: 'administrator',
        can_manage_topics: false,
        can_delete_messages: true,
        can_pin_messages: false,
      },
    ),
    (error: unknown) => {
      const typed = error as { code?: string; message?: string };
      return typed.code === 'TELEGRAM_ADMIN_PERMISSIONS_REQUIRED'
        && typed.message?.includes('Manage Topics') === true
        && typed.message?.includes('Pin Messages') === true;
    },
  );
});
