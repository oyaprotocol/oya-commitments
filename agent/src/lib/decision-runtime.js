import { callAgent, explainToolCalls, parseToolArguments } from './llm.js';
import {
    DECISION_STATUS,
    evaluateToolOutputsDecisionStatus,
    hasDeterministicDecisionEngine,
    isRetryableDecisionError,
} from './decision-support.js';
import { executeToolCalls, hasCommittedToolSideEffects, toolDefinitions } from './tools.js';

export function createDecisionRuntime({
    agentModule,
    config,
    publicClient,
    walletClient,
    account,
    agentAddress,
    commitmentText,
    getOgContext,
    ensureOgContext,
}) {
    async function processAgentToolCalls({
        toolCalls,
        signals,
        onchainPendingProposal,
        decisionResponseId,
    }) {
        let approvedToolCalls = toolCalls;
        if (typeof agentModule?.validateToolCalls === 'function') {
            try {
                const validated = await agentModule.validateToolCalls({
                    toolCalls: toolCalls.map((call) => ({
                        ...call,
                        parsedArguments: parseToolArguments(call.arguments),
                    })),
                    signals,
                    commitmentText,
                    commitmentSafe: config.commitmentSafe,
                    agentAddress,
                    publicClient,
                    config,
                    onchainPendingProposal,
                });
                if (Array.isArray(validated)) {
                    approvedToolCalls = validated.map((call) => ({
                        name: call.name,
                        callId: call.callId,
                        arguments:
                            call.parsedArguments !== undefined
                                ? JSON.stringify(call.parsedArguments)
                                : call.arguments !== undefined
                                    ? call.arguments
                                    : JSON.stringify({}),
                    }));
                } else {
                    approvedToolCalls = [];
                }
            } catch (error) {
                const retryableValidationError = isRetryableDecisionError(error);
                console.warn(
                    '[agent] validateToolCalls failed:',
                    error?.message ?? error
                );
                return retryableValidationError
                    ? DECISION_STATUS.FAILED_RETRYABLE
                    : DECISION_STATUS.FAILED_NON_RETRYABLE;
            }
        }

        if (approvedToolCalls.length === 0) {
            console.log('[agent] No approved tool calls after validation');
            return DECISION_STATUS.NO_ACTION;
        }

        console.log('[agent] Executing', approvedToolCalls.length, 'approved tool call(s):', approvedToolCalls.map(c => c.name).join(', '));
        let toolOutputs;
        try {
            toolOutputs = await executeToolCalls({
                toolCalls: approvedToolCalls,
                publicClient,
                walletClient,
                account,
                config,
                ogContext: getOgContext(),
            });
        } catch (error) {
            const sideEffectsLikelyCommitted = hasCommittedToolSideEffects(error);
            const retryableExecutionError = isRetryableDecisionError(error);
            console.error('[agent] Tool execution failed:', error?.message ?? error);
            if (sideEffectsLikelyCommitted) {
                return DECISION_STATUS.FAILED_NON_RETRYABLE;
            }
            return retryableExecutionError
                ? DECISION_STATUS.FAILED_RETRYABLE
                : DECISION_STATUS.FAILED_NON_RETRYABLE;
        }

        for (const output of toolOutputs) {
            if (!output?.name || typeof output.output !== 'string') {
                continue;
            }
            let payload = null;
            try {
                payload = JSON.parse(output.output);
            } catch (error) {
                continue;
            }
            const status =
                typeof payload?.status === 'string' && payload.status.trim()
                    ? payload.status.trim().toLowerCase()
                    : '';
            if (status === 'error') {
                const message =
                    typeof payload?.message === 'string' && payload.message.trim()
                        ? payload.message.trim()
                        : 'unknown tool error';
                console.warn(
                    `[agent] Tool output error: name=${output.name} callId=${output.callId ?? 'unknown'} retryable=${payload?.retryable === true} sideEffectsLikelyCommitted=${payload?.sideEffectsLikelyCommitted === true} message=${message}`
                );
            } else if (status === 'skipped') {
                const reason =
                    typeof payload?.reason === 'string' && payload.reason.trim()
                        ? payload.reason.trim()
                        : 'no reason provided';
                console.warn(
                    `[agent] Tool output skipped: name=${output.name} callId=${output.callId ?? 'unknown'} reason=${reason}`
                );
            }
        }

        console.log('[agent] Tool outputs count:', toolOutputs.length, 'outputs:', JSON.stringify(toolOutputs.map(o => ({ name: o?.name, hasOutput: Boolean(o?.output), outputPreview: typeof o?.output === 'string' ? o.output.substring(0, 200) : String(o?.output) }))));
        if (toolOutputs.length > 0 && agentModule?.onToolOutput) {
            for (const output of toolOutputs) {
                if (!output?.name || !output?.output) {
                    continue;
                }
                let parsed;
                try {
                    parsed = JSON.parse(output.output);
                } catch (error) {
                    parsed = null;
                }
                try {
                    await agentModule.onToolOutput({
                        name: output.name,
                        parsedOutput: parsed,
                        commitmentText,
                        commitmentSafe: config.commitmentSafe,
                        agentAddress,
                        config,
                    });
                } catch (error) {
                    console.warn('[agent] onToolOutput hook failed:', error?.message ?? error);
                }
            }
        }

        const modelCallIds = new Set(
            approvedToolCalls
                .map((call) => call?.callId)
                .filter((callId) => typeof callId === 'string' && callId.length > 0)
        );
        const explainableOutputs = toolOutputs.filter(
            (output) => output?.callId && modelCallIds.has(output.callId)
        );

        if (decisionResponseId && explainableOutputs.length > 0) {
            try {
                const explanation = await explainToolCalls({
                    config,
                    previousResponseId: decisionResponseId,
                    toolOutputs: explainableOutputs,
                });
                if (explanation) {
                    console.log('[agent] Agent explanation:', explanation);
                }
            } catch (error) {
                console.warn(
                    '[agent] Failed to fetch post-tool explanation:',
                    error?.message ?? error
                );
            }
        }
        return evaluateToolOutputsDecisionStatus(toolOutputs);
    }

    async function decideOnSignals(signals, { onchainPendingProposal = false } = {}) {
        if (hasDeterministicDecisionEngine(agentModule)) {
            try {
                const deterministicCalls = await agentModule.getDeterministicToolCalls({
                    signals,
                    commitmentText,
                    commitmentSafe: config.commitmentSafe,
                    agentAddress,
                    publicClient,
                    config,
                    onchainPendingProposal,
                });
                if (Array.isArray(deterministicCalls) && deterministicCalls.length > 0) {
                    console.log('[agent] Deterministic calls:', deterministicCalls.map(c => c.name).join(', '));
                    const result = await processAgentToolCalls({
                        toolCalls: deterministicCalls,
                        signals,
                        onchainPendingProposal,
                        decisionResponseId: null,
                    });
                    console.log('[agent] Deterministic result:', result);
                    return result;
                }
                return DECISION_STATUS.NO_ACTION;
            } catch (error) {
                const retryableDeterministicError = isRetryableDecisionError(error);
                console.error('[agent] Deterministic tool-call generation failed', error);
                return retryableDeterministicError
                    ? DECISION_STATUS.FAILED_RETRYABLE
                    : DECISION_STATUS.FAILED_NON_RETRYABLE;
            }
        }

        if (!config.openAiApiKey) {
            return DECISION_STATUS.NO_ACTION;
        }

        try {
            const ogContext = await ensureOgContext();
            const systemPrompt =
                agentModule?.getSystemPrompt?.({
                    proposeEnabled: config.proposeEnabled,
                    disputeEnabled: config.disputeEnabled,
                    commitmentText,
                }) ??
                'You are an agent monitoring an onchain commitment (Safe + Optimistic Governor).';

            const executableToolsEnabled =
                config.proposeEnabled ||
                config.disputeEnabled ||
                config.polymarketClobEnabled ||
                config.ipfsEnabled;
            const tools = toolDefinitions({
                proposeEnabled: config.proposeEnabled,
                disputeEnabled: config.disputeEnabled,
                clobEnabled: config.polymarketClobEnabled,
                ipfsEnabled: config.ipfsEnabled,
                onchainToolsEnabled: config.proposeEnabled || config.disputeEnabled,
            });
            const allowTools = executableToolsEnabled;
            const decision = await callAgent({
                config,
                systemPrompt,
                signals,
                ogContext,
                commitmentText,
                agentAddress,
                tools,
                allowTools,
            });

            if (!allowTools && decision?.textDecision) {
                console.log('[agent] Opinion:', decision.textDecision);
                return DECISION_STATUS.HANDLED;
            }

            if (decision.toolCalls.length > 0) {
                return processAgentToolCalls({
                    toolCalls: decision.toolCalls,
                    signals,
                    onchainPendingProposal,
                    decisionResponseId: decision.responseId,
                });
            }

            if (decision?.textDecision) {
                console.log('[agent] Decision:', decision.textDecision);
                return DECISION_STATUS.HANDLED;
            }
        } catch (error) {
            const retryableAgentError = isRetryableDecisionError(error);
            console.error('[agent] Agent call failed', error);
            return retryableAgentError
                ? DECISION_STATUS.FAILED_RETRYABLE
                : DECISION_STATUS.FAILED_NON_RETRYABLE;
        }

        return DECISION_STATUS.NO_ACTION;
    }

    return { decideOnSignals };
}
