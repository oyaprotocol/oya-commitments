import { createHash } from 'node:crypto';
import { assertCanonicalCid } from '@oyaprotocol/utils';
import { verifySignedMessage } from '@oyaprotocol/messages';
import { EvidenceError, evidenceEndpoint, evidenceLimit, evidenceAddress, evidenceKeys,
    evidenceJson, readEvidenceBytes, rawCidDigest, ledgerEvidenceSettings,
    ledgerEvidenceRecord, verifyLedgerEvidence } from './ledger-evidence.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const match = (condition, reason) => { if (!condition) throw new EvidenceError('mismatch', reason); };
const exactKeys = (value, fields) => {
    evidenceKeys(value, fields);
    if (Object.keys(value).length !== fields.length) throw new Error();
};

// Parse only authenticated manifest bytes. Metadata in the oldest format is descriptive,
// not an independently established execution identity or a substitute for CID binding.
export function parseBatchManifest(bytes) {
    try {
        if (!(bytes instanceof Uint8Array) || bytes.length > 131072) throw new Error();
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        let format = 'cid-lines', members;
        if (text.trimStart().startsWith('{')) {
            const value = JSON.parse(text);
            if (value.type !== 'oya-message-batch' || value.version !== 1) throw new Error();
            if (Object.hasOwn(value, 'execution') || Object.hasOwn(value, 'batchId')) {
                exactKeys(value, ['type', 'version', 'batchId', 'execution', 'messages']);
                if (typeof value.batchId !== 'string' ||
                    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.batchId)) throw new Error();
                exactKeys(value.execution, ['mode', 'chainId', 'ledgerContract', 'nodeAddress']);
                if (value.execution.mode !== 'ledger') throw new Error();
                evidenceLimit(value.execution.chainId, undefined, Number.MAX_SAFE_INTEGER);
                evidenceAddress(value.execution.ledgerContract);
                evidenceAddress(value.execution.nodeAddress);
                if (!Array.isArray(value.messages) || value.messages.length > 100) throw new Error();
                members = value.messages.map(entry => {
                    exactKeys(entry, ['cid', 'messageDigest']);
                    if (typeof entry.messageDigest !== 'string' || !/^[0-9a-f]{64}$/.test(entry.messageDigest)) throw new Error();
                    return entry.cid;
                });
                format = 'legacy-execution-json-v1';
            } else {
                exactKeys(value, ['type', 'version', 'messages']);
                members = value.messages;
                format = 'legacy-cid-json-v1';
            }
        } else members = text.split('\n');
        if (!Array.isArray(members) || !members.length || members.length > 100) throw new Error();
        members.forEach(cid => assertCanonicalCid(cid, 'member'));
        return { format, members };
    } catch { throw new EvidenceError('mismatch', 'invalid_manifest'); }
}

const initialReport = () => ({ version: 1, kind: 'batch-member', status: 'unavailable',
    reason: 'incomplete', stage: 'input', observedAt: new Date().toISOString(),
    checks: { manifest: 'not_checked', manifestFormat: 'not_checked', membership: 'not_checked', member: 'not_checked',
        signature: 'not_checked', signer: 'not_requested', ledger: 'not_requested', semantics: 'not_assessed' } });
export const batchEvidenceInputFailure = error => ({ ...initialReport(),
    status: error instanceof EvidenceError ? error.status : 'unavailable',
    reason: error instanceof EvidenceError ? error.reason : 'input_unreadable' });

function inputs(record, settings) {
    let config;
    try {
        evidenceKeys(settings, ['ipfsUrl', 'ipfsAuthorization', 'timeoutMs', 'requestTimeoutMs', 'ledger']);
        config = { ipfs: evidenceEndpoint(settings.ipfsUrl, settings.ipfsAuthorization, true),
            timeoutMs: evidenceLimit(settings.timeoutMs, 30000, 120000),
            requestTimeoutMs: evidenceLimit(settings.requestTimeoutMs, 10000, 30000) };
        if (settings.ledger !== undefined) {
            evidenceKeys(settings.ledger, ['chainId', 'ledgerContract', 'rpcUrl', 'rpcAuthorization']);
            config.ledger = { ...settings.ledger, ipfsUrl: settings.ipfsUrl,
                ipfsAuthorization: settings.ipfsAuthorization, timeoutMs: config.timeoutMs,
                requestTimeoutMs: config.requestTimeoutMs };
            ledgerEvidenceSettings(config.ledger);
        }
    } catch { throw new EvidenceError('mismatch', 'invalid_settings'); }
    try {
        evidenceKeys(record, ['manifestCid', 'memberCid', 'signer', 'ledger']);
        const expected = { manifestCid: assertCanonicalCid(record.manifestCid, 'manifest'),
            memberCid: assertCanonicalCid(record.memberCid, 'member') };
        if (record.signer !== undefined) expected.signer = evidenceAddress(record.signer);
        if ((record.ledger !== undefined) !== (config.ledger !== undefined)) throw new Error();
        if (record.ledger !== undefined) {
            evidenceKeys(record.ledger, ['transactionHash', 'logIndex', 'nodeAddress']);
            expected.ledger = ledgerEvidenceRecord({ ...record.ledger, cid: expected.manifestCid });
        }
        return { config, expected };
    } catch { throw new EvidenceError('mismatch', 'invalid_record'); }
}

export async function verifyBatchEvidence(record, settings) {
    const report = initialReport();
    const controller = new AbortController();
    let timer;
    try {
        const { config, expected } = inputs(record, settings);
        const deadline = Date.now() + config.timeoutMs;
        timer = setTimeout(() => controller.abort(), config.timeoutMs);
        report.manifestCid = expected.manifestCid;
        report.memberCid = expected.memberCid;
        if (expected.signer) {
            report.expectedSigner = expected.signer;
            report.checks.signer = 'not_checked';
        }
        if (expected.ledger) report.checks.ledger = 'not_checked';
        const checkDeadline = () => {
            if (controller.signal.aborted || Date.now() >= deadline) throw new EvidenceError('unavailable', 'deadline');
        };
        const retrieve = async (cid, field) => {
            report.stage = field;
            const digest = rawCidDigest(cid);
            if (digest === null) {
                report.checks[field] = 'unsupported';
                throw new EvidenceError('partial', `${field}_cid_unsupported`);
            }
            const bytes = await readEvidenceBytes(config.ipfs, `/api/v0/cat?arg=${encodeURIComponent(cid)}`,
                undefined, controller.signal, config.requestTimeoutMs);
            report[`${field}Bytes`] = bytes.length;
            match(sha256(bytes) === digest, `${field}_cid_content`);
            report.checks[field] = 'verified';
            checkDeadline();
            return bytes;
        };
        const manifestBytes = await retrieve(expected.manifestCid, 'manifest');
        report.stage = 'manifestFormat';
        const manifest = parseBatchManifest(manifestBytes);
        report.checks.manifestFormat = 'verified';
        report.format = manifest.format;
        if (manifest.format === 'legacy-execution-json-v1') report.legacyMetadata = 'not_assessed';
        report.memberCount = manifest.members.length;
        report.stage = 'membership';
        report.memberIndexes = manifest.members.flatMap((cid, i) => cid === expected.memberCid ? [i] : []);
        match(report.memberIndexes.length > 0, 'member_not_listed');
        report.checks.membership = 'verified';
        const bytes = await retrieve(expected.memberCid, 'member');
        report.stage = 'signature';
        let message;
        try {
            message = evidenceJson(bytes);
            exactKeys(message, ['text', 'signer', 'signature']);
            verifySignedMessage(message);
        } catch { throw new EvidenceError('mismatch', 'invalid_signed_message'); }
        report.checks.signature = 'verified';
        report.signer = message.signer.toLowerCase();
        report.textBytes = Buffer.byteLength(message.text);
        if (expected.signer) {
            report.stage = 'signer';
            match(report.signer === expected.signer, 'signer_identity');
            report.checks.signer = 'verified';
        }
        report.message = message;
        checkDeadline();
        if (expected.ledger) {
            report.stage = 'ledger';
            // Independent receipt verification rechecks the manifest. No member is fetched here.
            report.ledger = await verifyLedgerEvidence(expected.ledger,
                { ...config.ledger, timeoutMs: Math.max(1, deadline - Date.now()) });
            report.checks.ledger = report.ledger.checks.ledger;
            if (report.ledger.status !== 'verified') throw new EvidenceError(report.ledger.status, 'ledger_evidence_failed');
            checkDeadline();
        }
        report.stage = 'complete';
        report.status = 'verified';
        report.reason = expected.ledger ? 'batch_member_and_ledger_verified' : 'batch_member_verified';
    } catch (error) {
        report.status = error instanceof EvidenceError ? error.status : 'mismatch';
        report.reason = error instanceof EvidenceError ? error.reason : 'malformed_evidence';
        if (Object.hasOwn(report.checks, report.stage) &&
            !['verified', 'unsupported'].includes(report.checks[report.stage])) report.checks[report.stage] = report.status;
    } finally {
        clearTimeout(timer);
        controller.abort();
        report.observedAt = new Date().toISOString();
    }
    return report;
}
