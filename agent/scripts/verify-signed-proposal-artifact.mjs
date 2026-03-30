import { readFile } from 'node:fs/promises';
import { verifySignedProposalArtifact } from '../src/lib/signed-proposal.js';
import {
    getArgValue,
    hasFlag,
    isDirectScriptExecution,
    loadScriptEnv,
} from './lib/cli-runtime.mjs';

loadScriptEnv();

function printUsage() {
    console.log(`Usage:
  node agent/scripts/verify-signed-proposal-artifact.mjs --file=<path>
  node agent/scripts/verify-signed-proposal-artifact.mjs --json='<artifact-json>'

Options:
  --file=<path>                        Path to a JSON artifact file
  --json='<artifact-json>'             Raw artifact JSON
  --help                               Show this help
`);
}

async function loadArtifactInput({ argv = process.argv }) {
    const filePath = getArgValue('--file=', argv);
    const rawJson = getArgValue('--json=', argv);
    if ((filePath ? 1 : 0) + (rawJson ? 1 : 0) !== 1) {
        throw new Error('Provide exactly one of --file or --json.');
    }

    const raw = filePath ? await readFile(filePath, 'utf8') : rawJson;
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error('Artifact input must be valid JSON.');
    }
}

async function main() {
    if (hasFlag('--help', process.argv) || hasFlag('-h', process.argv)) {
        printUsage();
        return;
    }

    const artifact = await loadArtifactInput({});
    const result = await verifySignedProposalArtifact(artifact);
    console.log(JSON.stringify(result, null, 2));
}

if (isDirectScriptExecution(import.meta.url)) {
    main().catch((error) => {
        console.error('[oya-node] verify signed proposal artifact failed:', error?.message ?? error);
        process.exit(1);
    });
}

export { loadArtifactInput, main };
