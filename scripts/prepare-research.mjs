import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
const python=path.resolve(process.platform==='win32'?'local-agent/research/.venv/Scripts/python.exe':'local-agent/research/.venv/bin/python');
if(!existsSync(python)) throw new Error('Create the research virtual environment first. See README.md.');
const r=spawnSync(python,['build.py'],{cwd:'local-agent/research',stdio:'inherit',shell:false});
process.exit(r.status??1);
