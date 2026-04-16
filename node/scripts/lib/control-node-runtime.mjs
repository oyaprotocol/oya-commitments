import { importAgentModule } from './shared-agent-import.mjs';

const [
    { createValidatedReadWriteRuntime },
    { createMessagePublicationStore },
    { loadOgContext },
    { pollProposalChanges },
    { executeToolCalls },
] = await Promise.all([
    importAgentModule(
        new URL('../../../agent/src/lib/chain-runtime.js', import.meta.url).href,
        'src/lib/chain-runtime.js'
    ),
    importAgentModule(
        new URL('../../../agent/src/lib/message-publication-store.js', import.meta.url).href,
        'src/lib/message-publication-store.js'
    ),
    importAgentModule(
        new URL('../../../agent/src/lib/og.js', import.meta.url).href,
        'src/lib/og.js'
    ),
    importAgentModule(
        new URL('../../../agent/src/lib/polling.js', import.meta.url).href,
        'src/lib/polling.js'
    ),
    importAgentModule(
        new URL('../../../agent/src/lib/tools.js', import.meta.url).href,
        'src/lib/tools.js'
    ),
]);

export {
    createMessagePublicationStore,
    createValidatedReadWriteRuntime,
    executeToolCalls,
    loadOgContext,
    pollProposalChanges,
};
