import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ledgerEvidenceSettings, verifyLedgerEvidence } from '../ledger-evidence.mjs';
import { PeerSendError, loadSaved, sendFromNode, peerJobStatus } from './send.mjs';

function integer(value, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new PeerSendError('invalid_test_limits');
    return value;
}

/** Explicit finite execution. Receiver reports never substitute for independent evidence. */
export async function testNode({ nodeAddress, textFile, settings, count, timeoutMs, execute,
    pollIntervalMs = 1000, maxPolls = 120 }, { env = process.env, signal, transport } = {}) {
    if (execute !== true) throw new PeerSendError('execution_intent_required');
    integer(count, 1, 20);
    integer(timeoutMs, 1, 600000);
    integer(pollIntervalMs, 250, 10000);
    integer(maxPolls, 1, 120);
    // Validate and snapshot explicit settings before any signing or submission.
    let config;
    try { config = structuredClone(settings); ledgerEvidenceSettings(config); }
    catch { throw new PeerSendError('invalid_evidence_settings'); }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const started = performance.now();
    const deadline = started + timeoutMs;
    const timer = setTimeout(abort, timeoutMs);
    const report = { version: 1, outcome: 'stopped', reason: 'incomplete', requested: count,
        verified: 0, jobs: [] };

    const events = new Set();
    const check = () => {
        if (performance.now() >= deadline) controller.abort();
        controller.signal.throwIfAborted();
    };
    const options = { env, transport, signal: controller.signal, check };
    try {
        for (let index = 0; index < count; index++) {
            check();
            const sent = await sendFromNode(nodeAddress, textFile, options);
            const entry = { savedFile: sent.savedFile, requestId: sent.requestId, admission: sent,
                polls: 0, evidence: { status: 'not_checked' } };
            report.jobs.push(entry);
            check();
            if (sent.outcome !== 'admitted') { report.reason = sent.outcome; return report; }
            if (['failed', 'expired', 'published'].includes(sent.execution)) {
                report.reason = 'reported_' + sent.execution; return report;
            }
            const saved = await loadSaved(sent.savedFile);
            if (saved.job.requestId !== sent.requestId || saved.destination.nodeAddress !== sent.nodeAddress) {
                throw new PeerSendError('saved_identity_changed');
            }
            // Match publishSignedMessage's fixed serialization, not JSONB key ordering.
            const { text, signer, signature } = saved.job.message;
            const contentSha256 = createHash('sha256').update(JSON.stringify({ text, signer, signature })).digest('hex');
            for (let poll = 0; poll < maxPolls; poll++) {
                check();
                if (poll) await delay(pollIntervalMs, undefined, { signal: controller.signal });
                check();
                const status = await peerJobStatus(sent.savedFile, { ...options, evidence: true });
                entry.polls++;
                entry.reported = status;
                check();
                if (status.outcome !== 'status') { report.reason = status.outcome; return report; }
                if (['failed', 'expired', 'published'].includes(status.execution)) {
                    report.reason = 'reported_' + status.execution; return report;
                }
                if (status.execution !== 'logged') continue;
                entry.evidence = await verifyLedgerEvidence({ transactionHash: status.transactionHash,
                    cid: status.cid, nodeAddress: saved.destination.nodeAddress, contentSha256 }, config,
                { signal: controller.signal });
                check();
                if (entry.evidence.status !== 'verified' || entry.evidence.checks.cidBinding !== 'verified') {
                    report.reason = 'evidence_not_verified'; return report;
                }
                const event = `${entry.evidence.transactionHash}:${entry.evidence.logIndex}`;
                if (events.has(event)) { report.reason = 'reused_event'; return report; }
                events.add(event);
                entry.exactMessage = 'verified';
                report.verified++;
                break;
            }
            if (entry.exactMessage !== 'verified') { report.reason = 'poll_limit'; return report; }
        }
        report.outcome = 'completed';
        report.reason = 'count_complete';
    } catch (error) {
        if (controller.signal.aborted) report.reason = signal?.aborted ? 'cancelled' : 'deadline';
        else {
            report.reason = 'local_error';
            report.code = error instanceof PeerSendError ? error.code : 'local_failure';
            if (error instanceof PeerSendError && error.savedFile) report.savedFile = error.savedFile;
        }
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        controller.abort();
        report.elapsedMs = Math.ceil(performance.now() - started);
    }
    return report;
}
