// Собирает веб-часть для Android-приложения: копирует файлы PWA в www/
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const FILES = ['index.html', 'core.js', 'quotes.js', 'manifest.webmanifest', 'sw.js',
  'icon-192.png', 'icon-512.png', 'icon-192-maskable.png', 'icon-512-maskable.png', 'apple-touch-icon.png'];

rmSync('www', { recursive: true, force: true });
mkdirSync('www');
FILES.forEach(f => cpSync(f, 'www/' + f));
console.log('www/: ' + FILES.length + ' файлов');
