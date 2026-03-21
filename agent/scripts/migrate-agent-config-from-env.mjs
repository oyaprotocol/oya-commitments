import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { buildConfigMigrationPatch, finalizeConfigMigration } from './lib/config-migration.mjs';
import {
    getArgValue,
    hasFlag,
    isDirectScriptExecution,
    loadScriptEnv,
    repoRoot,
    resolveConfiguredChainIdForScript,
    resolveAgentDirectory,
    resolveAgentRef,
} from './lib/cli-runtime.mjs';

loadScriptEnv();

async function readJsonObject(filePath) {
    try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`${filePath} must be a JSON object`);
        }
        return parsed;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return {};
        }
        throw error;
    }
}

function printUsage() {
    console.log(`Usage:
node agent/scripts/migrate-agent-config-from-env.mjs --module=<agent-name> [--chain-id=<id>] [--out=<path>] [--dry-run]

Moves non-secret legacy env config into module-local JSON config.

Defaults:
  --module     AGENT_MODULE or "default"
  --chain-id   selected agent config chain when it resolves uniquely; otherwise omitted unless you pass --chain-id explicitly
  --out        <module-dir>/config.local.json
`);
}

async function main() {
    if (hasFlag('--help') || hasFlag('-h')) {
        printUsage();
        return;
    }

    const agentRef = getArgValue('--module=') ?? resolveAgentRef();
    const explicitChainId = getArgValue('--chain-id=');
    const chainId =
        explicitChainId ??
        (await resolveConfiguredChainIdForScript(agentRef, {
            repoRootPath: repoRoot,
            env: process.env,
        }).catch(() => undefined));
    const outArg = getArgValue('--out=');
    const moduleDir = resolveAgentDirectory(agentRef, { repoRootPath: repoRoot });
    const outputPath = outArg ? path.resolve(outArg) : path.join(moduleDir, 'config.local.json');

    const patch = buildConfigMigrationPatch({
        env: process.env,
        moduleName: agentRef,
        chainId,
    });

    if (Object.keys(patch).length === 0) {
        throw new Error(
            'No migratable non-secret env config found. Populate legacy env vars first or migrate values manually.'
        );
    }

    const existing = await readJsonObject(outputPath);
    const merged = finalizeConfigMigration({
        existingConfig: existing,
        patch,
        chainId,
    });

    if (hasFlag('--dry-run')) {
        console.log(JSON.stringify({ outputPath, patch: merged }, null, 2));
        return;
    }

    await writeFile(outputPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    console.log(
        `[agent] Wrote migrated config to ${outputPath}. Remove the migrated non-secret env vars after verifying the config.`
    );
}

export { main };

if (isDirectScriptExecution(import.meta.url)) {
    main().catch((error) => {
        console.error('[agent] config migration failed:', error?.message ?? error);
        process.exit(1);
    });
}
