import path from 'node:path';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

function sanitizeSessionSegment(value, fallback = 'default') {
    const rawValue = typeof value === 'string' ? value.trim() : '';
    if (!rawValue) {
        return fallback;
    }
    const normalized = rawValue.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return normalized || fallback;
}

function getHarnessSessionPaths({ repoRootPath, agentRef, profile }) {
    const moduleSegment = sanitizeSessionSegment(agentRef, 'default');
    const profileSegment = sanitizeSessionSegment(profile, 'default');
    const stateRoot = path.join(repoRootPath, 'agent', '.state', 'harness');
    const sessionDir = path.join(stateRoot, moduleSegment, profileSegment);

    return {
        stateRoot,
        sessionDir,
        files: {
            overlay: path.join(sessionDir, 'overlay.json'),
            deployment: path.join(sessionDir, 'deployment.json'),
            roles: path.join(sessionDir, 'roles.json'),
            pids: path.join(sessionDir, 'pids.json'),
            agentLog: path.join(sessionDir, 'agent.log'),
            anvilLog: path.join(sessionDir, 'anvil.log'),
            ipfsLog: path.join(sessionDir, 'ipfs.log'),
        },
    };
}

async function pathExists(targetPath) {
    try {
        await stat(targetPath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function ensureHarnessSession({ repoRootPath, agentRef, profile }) {
    const sessionPaths = getHarnessSessionPaths({ repoRootPath, agentRef, profile });
    await mkdir(sessionPaths.sessionDir, { recursive: true });
    return sessionPaths;
}

async function readHarnessJson(filePath) {
    try {
        const raw = await readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

async function writeHarnessJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function ensureHarnessJson(filePath, fallbackValue) {
    const existing = await readHarnessJson(filePath);
    if (existing !== null) {
        return existing;
    }
    await writeHarnessJson(filePath, fallbackValue);
    return fallbackValue;
}

async function ensureHarnessOverlayFile(sessionPaths) {
    return await ensureHarnessJson(sessionPaths.files.overlay, {});
}

async function readHarnessPids(sessionPaths) {
    return (await readHarnessJson(sessionPaths.files.pids)) ?? {};
}

async function writeHarnessPids(sessionPaths, value) {
    await writeHarnessJson(sessionPaths.files.pids, value);
}

async function resetHarnessSession({ repoRootPath, agentRef, profile }) {
    const sessionPaths = getHarnessSessionPaths({ repoRootPath, agentRef, profile });
    await rm(sessionPaths.sessionDir, { recursive: true, force: true });
    return sessionPaths;
}

async function readHarnessSessionStatus({ repoRootPath, agentRef, profile }) {
    const sessionPaths = getHarnessSessionPaths({ repoRootPath, agentRef, profile });
    const sessionDirExists = await pathExists(sessionPaths.sessionDir);

    const fileStatuses = {};
    for (const [name, filePath] of Object.entries(sessionPaths.files)) {
        fileStatuses[name] = {
            path: filePath,
            exists: await pathExists(filePath),
        };
    }

    return {
        ...sessionPaths,
        exists: sessionDirExists,
        data: {
            overlay: fileStatuses.overlay.exists
                ? await readHarnessJson(sessionPaths.files.overlay)
                : null,
            deployment: fileStatuses.deployment.exists
                ? await readHarnessJson(sessionPaths.files.deployment)
                : null,
            roles: fileStatuses.roles.exists ? await readHarnessJson(sessionPaths.files.roles) : null,
            pids: fileStatuses.pids.exists ? await readHarnessJson(sessionPaths.files.pids) : null,
        },
        fileStatuses,
    };
}

export {
    ensureHarnessJson,
    ensureHarnessOverlayFile,
    ensureHarnessSession,
    getHarnessSessionPaths,
    readHarnessPids,
    readHarnessJson,
    readHarnessSessionStatus,
    resetHarnessSession,
    sanitizeSessionSegment,
    writeHarnessPids,
    writeHarnessJson,
};
