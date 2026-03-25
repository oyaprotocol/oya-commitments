import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

export function createEmptyTradeIntentState() {
    return {
        nextSequence: 1,
        intents: {},
        deposits: {},
        reimbursementCommitments: {},
        pendingExecutedProposalHashes: [],
        pendingDeletedProposalHashes: [],
        backfilledDepositsThroughBlock: null,
        backfilledReimbursementCommitmentsThroughBlock: null,
    };
}

export async function readPersistedTradeIntentState(statePath) {
    try {
        const raw = await readFile(statePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

export async function writePersistedTradeIntentState(statePath, payload) {
    await mkdir(path.dirname(statePath), { recursive: true });

    const tempPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
    const serialized = JSON.stringify(payload, null, 2);
    try {
        await writeFile(tempPath, serialized, 'utf8');
        await rename(tempPath, statePath);
    } catch (error) {
        try {
            await unlink(tempPath);
        } catch (unlinkError) {
            if (unlinkError?.code !== 'ENOENT') {
                throw unlinkError;
            }
        }
        throw error;
    }
}

export async function deletePersistedTradeIntentState(statePath) {
    try {
        await unlink(statePath);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }
}
