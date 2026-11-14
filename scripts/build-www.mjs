// Собирает веб-часть для Android-приложения: копирует файлы PWA в www/
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const FILES = ['index.html', 'core.js', 'quotes.js', 'xlsx.js', 'template.js', 'manifest.webmanifest', 'sw.js',
  'icon-192.png', 'icon-512.png', 'icon-192-maskable.png', 'icon-512-maskable.png', 'apple-touch-icon.png'];

rmSync('www', { recursive: true, force: true });
mkdirSync('www');
FILES.forEach(f => cpSync(f, 'www/' + f));
// номер версии APK (VERSION_NAME из CI) — в «Ещё → О приложении»
if (process.env.VERSION_NAME) {
  const html = readFileSync('www/index.html', 'utf8');
  const out = html.replace(/const APP_VERSION = '[^']*';/, `const APP_VERSION = '${process.env.VERSION_NAME}';`);
  if (out === html) throw new Error('APP_VERSION не найден в index.html');
  writeFileSync('www/index.html', out);
}
console.log('www/: ' + FILES.length + ' файлов');
