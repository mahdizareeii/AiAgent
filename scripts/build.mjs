import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir } from 'node:fs/promises';
import { copyBundledSkills } from './copy-bundled-skills.mjs';
await mkdir('dist', { recursive: true });
await copyBundledSkills();
await build({entryPoints:['local-agent/desktop/main.ts','local-agent/desktop/preload.ts','local-agent/desktop/action-bridge.ts'],outdir:'dist',bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},external:['electron'],target:'node24',sourcemap:true});
await viteBuild({configFile:'local-agent/desktop/renderer/vite.config.ts'});
