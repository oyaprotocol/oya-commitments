const TOOL_EXECUTION_SIDE_EFFECTS_FLAG = 'toolExecutionSideEffectsLikelyCommitted';

function annotateToolExecutionError(error, { sideEffectsLikelyCommitted }) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    // Preserve whether we likely crossed an external side-effect boundary before failing.
    wrapped[TOOL_EXECUTION_SIDE_EFFECTS_FLAG] = Boolean(sideEffectsLikelyCommitted);
    return wrapped;
}

function hasCommittedToolSideEffects(error) {
    return Boolean(error?.[TOOL_EXECUTION_SIDE_EFFECTS_FLAG]);
}

export { annotateToolExecutionError, hasCommittedToolSideEffects };
