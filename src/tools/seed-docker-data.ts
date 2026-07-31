#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { writeUtf8AtomicSync } from '../infrastructure/files/atomic-file.js';

interface SeedFile {
  name: string;
  sourcePath: string;
}

const dataDir = path.resolve(process.env.DATA_DIR ?? '/app/data');
const seedDataDir = path.resolve(process.env.SEED_DATA_DIR ?? '/seed/data');
const seedCredentialsPath = path.resolve(
  process.env.SEED_CREDENTIALS_PATH ?? '/seed/credentials.json',
);
const seedFiles: SeedFile[] = [
  ...['topics.json', 'settings.json', 'msg-map.json', 'update-checker.json'].map(name => ({
    name,
    sourcePath: path.join(seedDataDir, name),
  })),
  { name: 'credentials.json', sourcePath: seedCredentialsPath },
];

let copied = 0;
let skipped = 0;
let missing = 0;

for (const file of seedFiles) {
  const targetPath = path.join(dataDir, file.name);
  if (existsSync(targetPath)) {
    console.log(`[Seed] Keep existing ${file.name}`);
    skipped += 1;
    continue;
  }
  if (!existsSync(file.sourcePath)) {
    console.log(`[Seed] Source missing ${file.name}`);
    missing += 1;
    continue;
  }
  const sourceStat = statSync(file.sourcePath);
  if (!sourceStat.isFile()) throw new Error(`Seed source is not a regular file: ${file.sourcePath}`);
  const content = readFileSync(file.sourcePath, 'utf8');
  JSON.parse(content);
  writeUtf8AtomicSync(targetPath, content);
  console.log(`[Seed] Copied ${file.name}`);
  copied += 1;
}

console.log(`[Seed] Done: copied=${copied}, kept=${skipped}, missing=${missing}`);
