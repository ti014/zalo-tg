#!/usr/bin/env node
import path from 'path';
import { existsSync } from 'fs';
import { convertTgsToGif } from '../utils/media.js';

function usage(): void {
  console.error('Usage: npm run tgs:gif -- <input.tgs> <output.gif>');
}

async function main(): Promise<number> {
  const [, , inputArg, outputArg] = process.argv;
  if (!inputArg || !outputArg) {
    usage();
    return 2;
  }

  const inputPath = path.resolve(inputArg);
  const outputPath = path.resolve(outputArg);

  if (!inputPath.toLowerCase().endsWith('.tgs')) {
    console.error(`Input must be a .tgs file: ${inputPath}`);
    return 2;
  }
  if (!outputPath.toLowerCase().endsWith('.gif')) {
    console.error(`Output must be a .gif file: ${outputPath}`);
    return 2;
  }
  if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    return 2;
  }

  await convertTgsToGif(inputPath, outputPath);
  console.log(`Converted ${inputPath} -> ${outputPath}`);
  return 0;
}

main()
  .then(code => { process.exitCode = code; })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
