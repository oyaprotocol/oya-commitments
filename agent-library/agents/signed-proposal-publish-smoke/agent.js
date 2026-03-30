function getSystemPrompt({ commitmentText }) {
    return [
        'You are a smoke-test agent for signed proposal publication.',
        'Focus on producing auditable proposal bundles and explanations for offchain publication.',
        'Treat signed proposal artifacts as review material for co-owners and observers.',
        'Never call tools.',
        'Return strict JSON with keys: action, rationale, publishRequestId, publishSummary.',
        'Allowed action values: archive_signed_proposal, ignore, clarify.',
        commitmentText ? `Commitment text:\n${commitmentText}` : '',
    ]
        .filter(Boolean)
        .join(' ');
}

async function getDeterministicToolCalls() {
    return [];
}

export { getDeterministicToolCalls, getSystemPrompt };
