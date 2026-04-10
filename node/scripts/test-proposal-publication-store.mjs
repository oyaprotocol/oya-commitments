import { importAgentModule } from './lib/shared-agent-import.mjs';

await importAgentModule(
    new URL('../../agent/scripts/test-proposal-publication-store.mjs', import.meta.url).href,
    'scripts/test-proposal-publication-store.mjs'
);
