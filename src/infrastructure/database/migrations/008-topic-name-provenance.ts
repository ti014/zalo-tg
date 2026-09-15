import type { Migration } from './types.js';

export const topicNameProvenanceMigration: Migration = {
  version: 8,
  name: 'topic-name-provenance',
  sql: `
    ALTER TABLE topic_links
      ADD COLUMN name_source TEXT NOT NULL DEFAULT 'legacy'
      CHECK (name_source IN (
        'legacy', 'placeholder', 'contact',
        'group_info', 'group_list', 'group_event'
      ));
  `,
};
