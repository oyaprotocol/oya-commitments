import { importAgentModule } from './lib/shared-agent-import.mjs';

await importAgentModule(
    new URL('../../agent/scripts/test-message-publication-api.mjs', import.meta.url).href,
    'scripts/test-message-publication-api.mjs'
);
