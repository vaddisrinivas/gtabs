import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'fs';

const isWatch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  target: 'chrome120',
  format: 'iife',
};

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('manifest.json', 'dist/manifest.json');
cpSync('src/popup.html', 'dist/popup.html');
cpSync('src/options.html', 'dist/options.html');

cpSync('icons', 'dist/icons', { recursive: true });

const entries = [
  { ...common, entryPoints: ['src/background.ts'], outfile: 'dist/background.js' },
  { ...common, entryPoints: ['src/popup.ts'], outfile: 'dist/popup.js' },
  { ...common, entryPoints: ['src/options.ts'], outfile: 'dist/options.js' },

];

if (isWatch) {
  for (const entry of entries) {
    const ctx = await context(entry);
    await ctx.watch();
  }
  console.log('Watching for changes...');
} else {
  await Promise.all(entries.map(e => build(e)));
  console.log('Build complete → dist/');
}
