import { copyFile, mkdir } from 'node:fs/promises';
await mkdir(new URL('../public/vendor/', import.meta.url), { recursive: true });
await copyFile(new URL('../node_modules/jsqr/dist/jsQR.js', import.meta.url), new URL('../public/vendor/jsQR.js', import.meta.url));
await copyFile(new URL('../node_modules/jsqr/LICENSE', import.meta.url), new URL('../public/vendor/jsQR-LICENSE.txt', import.meta.url));
