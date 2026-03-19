import { makeDeposit, postBondAndDispute, postBondAndPropose } from './lib/tx.js';
import { initializeAgentRuntime } from './lib/runtime-bootstrap.js';
import { createSignalPreparationRuntime } from './lib/signal-prep.js';
import { createDecisionRuntime } from './lib/decision-runtime.js';
import { createAgentLoopRunner } from './lib/runtime-loop.js';

const {
    config,
    publicClient,
    account,
    walletClient,
    agentAddress,
    agentModule,
    commitmentText,
    trackedAssets,
    messageInbox,
    pollingOptions,
} = await initializeAgentRuntime();

const signalPreparation = createSignalPreparationRuntime({
    agentModule,
    publicClient,
    config,
    account,
    commitmentText,
    trackedAssets,
});
const loopRunner = createAgentLoopRunner({
    config,
    publicClient,
    walletClient,
    account,
    agentModule,
    commitmentText,
    trackedAssets,
    messageInbox,
    pollingOptions,
    signalPreparation,
    decideOnSignals: null,
});
const decisionRuntime = createDecisionRuntime({
    agentModule,
    config,
    publicClient,
    walletClient,
    account,
    agentAddress,
    commitmentText,
    getOgContext: loopRunner.getOgContext,
    ensureOgContext: loopRunner.ensureOgContext,
});
loopRunner.setDecideOnSignals(decisionRuntime.decideOnSignals);
const { startAgent } = loopRunner;

if (import.meta.url === `file://${process.argv[1]}`) {
    startAgent().catch((error) => {
        console.error('[agent] failed to start', error);
        process.exit(1);
    });
}

export { makeDeposit, postBondAndDispute, postBondAndPropose, startAgent };
