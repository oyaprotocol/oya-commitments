import { parseToolArguments } from './utils.js';

function extractFirstText(responseJson) {
    const outputs = responseJson?.output;
    if (!Array.isArray(outputs)) return '';

    for (const item of outputs) {
        if (!item?.content) continue;
        for (const chunk of item.content) {
            if (chunk?.text) return chunk.text;
            if (chunk?.output_text) return chunk.output_text?.text ?? '';
            if (chunk?.text?.value) return chunk.text.value;
        }
    }

    return '';
}

function extractToolCalls(responseJson) {
    const outputs = responseJson?.output;
    if (!Array.isArray(outputs)) return [];

    const toolCalls = [];
    for (const item of outputs) {
        if (item?.type === 'tool_call' || item?.type === 'function_call') {
            toolCalls.push({
                name: item?.name ?? item?.function?.name,
                arguments: item?.arguments ?? item?.function?.arguments,
                callId: item?.call_id ?? item?.id,
            });
            continue;
        }

        if (Array.isArray(item?.tool_calls)) {
            for (const call of item.tool_calls) {
                toolCalls.push({
                    name: call?.name ?? call?.function?.name,
                    arguments: call?.arguments ?? call?.function?.arguments,
                    callId: call?.call_id ?? call?.id,
                });
            }
        }
    }

    return toolCalls.filter((call) => call.name);
}

async function callAgent({
    config,
    systemPrompt,
    signals,
    ogContext,
    commitmentText,
    agentAddress,
    tools,
    allowTools,
}) {
    const safeSignals = signals.map((signal) => {
        if (signal?.kind === 'proposal') {
            return {
                ...signal,
                challengeWindowEnds:
                    signal.challengeWindowEnds !== undefined
                        ? signal.challengeWindowEnds.toString()
                        : undefined,
                transactions: Array.isArray(signal.transactions)
                    ? signal.transactions.map((tx) => ({
                          ...tx,
                          value: tx.value !== undefined ? tx.value.toString() : undefined,
                      }))
                    : undefined,
            };
        }

        return {
            ...signal,
            amount: signal.amount !== undefined ? signal.amount.toString() : undefined,
            blockNumber: signal.blockNumber !== undefined ? signal.blockNumber.toString() : undefined,
            transactionHash: signal.transactionHash ? String(signal.transactionHash) : undefined,
            timestampMs:
                signal.timestampMs !== undefined ? signal.timestampMs.toString() : undefined,
            triggerTimestampMs:
                signal.triggerTimestampMs !== undefined
                    ? signal.triggerTimestampMs.toString()
                    : undefined,
        };
    });

    const safeContext = {
        rules: ogContext?.rules,
        identifier: ogContext?.identifier ? String(ogContext.identifier) : undefined,
        liveness: ogContext?.liveness !== undefined ? ogContext.liveness.toString() : undefined,
        collateral: ogContext?.collateral,
        bondAmount: ogContext?.bondAmount !== undefined ? ogContext.bondAmount.toString() : undefined,
        optimisticOracle: ogContext?.optimisticOracle,
    };

    const payload = {
        model: config.openAiModel,
        input: [
            {
                role: 'system',
                content: systemPrompt,
            },
            {
                role: 'user',
                content: JSON.stringify(
                    {
                        commitmentSafe: config.commitmentSafe,
                        ogModule: config.ogModule,
                        agentAddress,
                        ogContext: safeContext,
                        commitment: commitmentText,
                        signals: safeSignals,
                    },
                    (_, value) => (typeof value === 'bigint' ? value.toString() : value)
                ),
            },
        ],
        tools: allowTools ? tools : [],
        tool_choice: allowTools ? 'auto' : 'none',
        parallel_tool_calls: false,
        text: { format: { type: 'json_object' } },
    };

    const res = await fetch(`${config.openAiBaseUrl}/responses`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.openAiApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI API error: ${res.status} ${text}`);
    }

    const json = await res.json();
    const toolCalls = allowTools ? extractToolCalls(json) : [];
    const raw = extractFirstText(json);
    let textDecision;
    if (raw) {
        try {
            textDecision = JSON.parse(raw);
        } catch (error) {
            throw new Error(`Failed to parse OpenAI JSON: ${raw}`);
        }
    }

    return { toolCalls, textDecision, responseId: json?.id };
}

async function explainToolCalls({ config, previousResponseId, toolOutputs }) {
    const input = [
        ...toolOutputs.map((item) => ({
            type: 'function_call_output',
            call_id: item.callId,
            output: item.output,
        })),
        {
            type: 'message',
            role: 'user',
            content: [
                {
                    type: 'input_text',
                    text: 'Summarize the actions you took and why.',
                },
            ],
        },
    ];

    const res = await fetch(`${config.openAiBaseUrl}/responses`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.openAiApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: config.openAiModel,
            previous_response_id: previousResponseId,
            input,
        }),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI API error: ${res.status} ${text}`);
    }

    const json = await res.json();
    return extractFirstText(json);
}

export { callAgent, explainToolCalls, extractToolCalls, extractFirstText, parseToolArguments };
