import { importAgentModule } from './shared-agent-import.mjs';

const {
    buildProposalPublishBaseUrl,
    createProposalPublishSubmissionRuntimeResolver,
    resolveProposalPublishApiConfigForAgent,
    resolveProposalPublishApiTarget,
    resolveProposalPublishServerConfig,
    resolveProposalPublishStateFile,
} = await importAgentModule(
    new URL('../../../agent/scripts/lib/proposal-publish-runtime.mjs', import.meta.url).href,
    'scripts/lib/proposal-publish-runtime.mjs'
);

export {
    buildProposalPublishBaseUrl,
    createProposalPublishSubmissionRuntimeResolver,
    resolveProposalPublishApiConfigForAgent,
    resolveProposalPublishApiTarget,
    resolveProposalPublishServerConfig,
    resolveProposalPublishStateFile,
};
