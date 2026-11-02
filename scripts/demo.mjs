import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const electron = createRequire(import.meta.url)('electron');
spawn(electron, [root], { stdio: 'inherit', env: { ...process.env, FLEET_DEMO: '1', FLEET_DATA: path.join(root, 'dist', 'demo-data') } });
