#!/usr/bin/env node
// scripts/copy-privacycash-assets.mjs
//
// Copies PrivacyCash's ZK circuit artifacts and Light hasher WASM from
// node_modules into public/privacycash/ so Next.js serves them as static
// assets. snarkjs's fullProve() is given URL paths to these files.
//
// Runs as a postinstall hook. Safe to re-run.

import {existsSync, mkdirSync, copyFileSync, statSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const publicDir = join(repoRoot, 'public', 'privacycash');

mkdirSync(publicDir, {recursive: true});

const sources = [
    {
        from: join(repoRoot, 'node_modules', 'privacycash', 'circuit2', 'transaction2.wasm'),
        to: join(publicDir, 'transaction2.wasm'),
    },
    {
        from: join(repoRoot, 'node_modules', 'privacycash', 'circuit2', 'transaction2.zkey'),
        to: join(publicDir, 'transaction2.zkey'),
    },
];

let copied = 0;
let skipped = 0;
for (const {from, to} of sources) {
    if (!existsSync(from)) {
        console.warn(`[privacycash-assets] source missing: ${from}`);
        continue;
    }
    if (existsSync(to) && statSync(to).size === statSync(from).size) {
        skipped++;
        continue;
    }
    copyFileSync(from, to);
    copied++;
    console.log(`[privacycash-assets] copied ${from} -> ${to}`);
}

if (copied === 0 && skipped > 0) {
    console.log(`[privacycash-assets] up to date (${skipped} files unchanged)`);
}
