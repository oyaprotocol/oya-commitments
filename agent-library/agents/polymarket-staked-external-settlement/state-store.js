import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STATE_VERSION = 1;

function cloneJson(value) {
    if (value === undefined) {
        return undefined;
    }
    return JSON.parse(JSON.stringify(value));
}

function createEmptyState(scope = null) {
    return {
        version: STATE_VERSION,
        scope: cloneJson(scope),
        markets: {},
        processedCommands: {},
        disputedAssertionIds: [],
        pendingDispute: null,
    };
}

async function readPersistedState(statePath) {
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

async function writePersistedState(statePath, payload) {
    await mkdir(path.dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        await writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
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

async function deletePersistedState(statePath) {
    try {
        await unlink(statePath);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }
}

export {
    STATE_VERSION,
    cloneJson,
    createEmptyState,
    deletePersistedState,
    readPersistedState,
    writePersistedState,
};
