import type { TgHandlerContext } from '../types.js';
import { registerLoginCommand } from './login.js';
import { registerTopicCommand } from './topic.js';
import { registerRecallCommand } from './recall.js';
import { registerSearchCommand } from './search.js';
import { registerAddgroupCommand } from './addgroup.js';
import { registerAddfriendCommand } from './addfriend.js';
import { registerFriendrequestsCommand } from './friendrequests.js';
import { registerJoingroupCommand } from './joingroup.js';
import { registerLeavegroupCommand } from './leavegroup.js';
import { registerStatusCommand } from './status.js';
import { registerMenuCommand } from './menu.js';
import { registerSettingsCommand } from './settings.js';
import { registerHelpCommand } from './help.js';
import { registerBackupCommands } from './backup.js';
import { registerKickCommand, registerMembersCommand } from './members.js';

export function registerAllCommands(ctx: TgHandlerContext): void {
  registerMenuCommand(ctx);
  registerHelpCommand(ctx);
  registerSettingsCommand(ctx);
  registerLoginCommand(ctx);
  registerTopicCommand(ctx);
  registerRecallCommand(ctx);
  registerSearchCommand(ctx);
  registerAddgroupCommand(ctx);
  registerAddfriendCommand(ctx);
  registerFriendrequestsCommand(ctx);
  registerJoingroupCommand(ctx);
  registerLeavegroupCommand(ctx);
  registerStatusCommand(ctx);
  registerBackupCommands(ctx);
  registerMembersCommand(ctx);
  registerKickCommand(ctx);
}
