const LOOP_PHASE_WARN_INTERVAL_MS = 15_000;

function formatLoopPhaseContext(context) {
    if (!context || typeof context !== 'object') {
        return '';
    }
    const parts = Object.entries(context)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${value}`);
    return parts.length > 0 ? ` (${parts.join(' ')})` : '';
}

export async function runLoopPhase(
    name,
    work,
    {
        warnIntervalMs = LOOP_PHASE_WARN_INTERVAL_MS,
        logStart = false,
        context,
    } = {}
) {
    const startedAtMs = Date.now();
    const contextText = formatLoopPhaseContext(context);
    if (logStart) {
        console.log(`[agent] Loop phase started: ${name}${contextText}.`);
    }

    let warningCount = 0;
    const timer =
        warnIntervalMs > 0
            ? setInterval(() => {
                warningCount += 1;
                console.warn(
                    `[agent] Loop phase still running: ${name}${contextText} elapsedMs=${warningCount * warnIntervalMs}.`
                );
            }, warnIntervalMs)
            : null;
    timer?.unref?.();

    try {
        const result = await work();
        const durationMs = Date.now() - startedAtMs;
        if (logStart || durationMs >= warnIntervalMs) {
            console.log(
                `[agent] Loop phase complete: ${name}${contextText} durationMs=${durationMs}.`
            );
        }
        return result;
    } catch (error) {
        const durationMs = Date.now() - startedAtMs;
        console.error(
            `[agent] Loop phase failed: ${name}${contextText} durationMs=${durationMs}.`,
            error
        );
        throw error;
    } finally {
        if (timer) {
            clearInterval(timer);
        }
    }
}
