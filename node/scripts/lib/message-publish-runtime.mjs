import { importAgentModule } from './shared-agent-import.mjs';

const {
    resolveMessagePublishApiConfigForAgent,
    resolveMessagePublishNodeSigner,
    resolveMessagePublishServerConfig,
    resolveMessagePublishStateFile,
} = await importAgentModule(
    new URL('../../../agent/scripts/lib/message-publish-runtime.mjs', import.meta.url).href,
    'scripts/lib/message-publish-runtime.mjs'
);

export {
    resolveMessagePublishApiConfigForAgent,
    resolveMessagePublishNodeSigner,
    resolveMessagePublishServerConfig,
    resolveMessagePublishStateFile,
};
