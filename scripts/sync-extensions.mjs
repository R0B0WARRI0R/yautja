import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../extension/background.js', import.meta.url));
const target = fileURLToPath(new URL('../extension-chrome/background.js', import.meta.url));
const expected = readFileSync(source, 'utf8');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== expected) throw new Error('Extension handlers differ. Run npm run sync:extensions.');
} else writeFileSync(target, expected);
