// Trusted operator-only wrapper for existing stdin-based import/maintenance
// scripts. The script path is allowlisted; credentials are never arguments.
import {z} from 'zod';
import {withBot} from '../server/bot-workspaces.js';
const allowed=['import-persona-archive','bootstrap-persona','prepare-persona-specialist','seed-welcome-persona','seed-public-base-personas','import-model-credential','import-model-providers','migrate-persona-composition'] as const;
const id=z.uuid().parse(process.argv[2]),script=z.enum(allowed).parse(process.argv[3]);
await withBot(id,async()=>{await import('./'+script+'.js');});
