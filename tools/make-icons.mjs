#!/usr/bin/env node
/**
 * Install the extension icons from the brand package.
 *
 *   node tools/make-icons.mjs        → public/icons/icon-{16,32,48,128}.png
 *
 * The brand package (brand/, "Priority Path", 2026-09-10) ships the icons as
 * reviewed PNG exports in brand/05-chrome-extension/icons: the 16/32/48 sizes
 * fill the canvas for toolbar legibility and the 128 has the 16 px transparent
 * padding the Chrome Web Store asks for. Nothing is rasterised here; the
 * script copies the four files the manifest names and checks each one's
 * declared pixel size, so a wrong file cannot be installed silently.
 */
import { copyFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'brand/05-chrome-extension/icons');
const out = resolve(root, 'public/icons');
mkdirSync(out, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const file = `icon-${size}.png`;
  const bytes = readFileSync(resolve(src, file));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== size || height !== size) throw new Error(`${file} is ${width}×${height}, expected ${size}×${size}`);
  copyFileSync(resolve(src, file), resolve(out, file));
  console.log(`${resolve(out, file)}  ←  brand/05-chrome-extension/icons/${file}`);
}
