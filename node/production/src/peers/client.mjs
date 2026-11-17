import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PeerSendError, sendFromNode, sendToPeer, retryPeerJob, peerJobStatus } from './send.mjs';

const usage = `Usage: peer client send RECIPIENT TEXT_FILE
       peer client send REGISTRY_FILE NODE_ADDRESS KEY_FILE TEXT_FILE OUTPUT_FILE
       peer client retry SAVED_FILE
       peer client status SAVED_FILE
       peer client --help

Two-argument send uses OYA_LOCAL_DIR/node.json and node.env (node identity).
Registry: configured peers.registryFile or bundled list. Recovery: peer-outbox.
Select one installed registry entry by explicit address. OUTPUT_FILE must be new.
Save the ordinary v1 job before one HTTP request. Text is preserved exactly.
Use status after uncertain delivery; retry explicitly reuses the same saved job.
No key or registry is read by retry/status. No automatic retry or replacement.
JSON admission/execution describes remote claims, not proof of storage or logging.
Exit: 0 recognized admission/state, 1 remote/unknown/failed/expired, 2 local error.`;

export async function main(args = process.argv.slice(2)) {
    if (args.length === 1 && args[0] === '--help') { console.log(usage); return 0; }
    const [command, ...rest] = args;
    try {
        let result;
        if (command === 'send' && rest.length === 2) {
            result = await sendFromNode(rest[0], rest[1]);
        } else if (command === 'send' && rest.length === 5) {
            const [registryFile, nodeAddress, keyFile, textFile, outputFile] = rest;
            result = await sendToPeer({ registryFile, nodeAddress, keyFile, textFile, outputFile });
        } else if (command === 'retry' && rest.length === 1) result = await retryPeerJob(rest[0]);
        else if (command === 'status' && rest.length === 1) result = await peerJobStatus(rest[0]);
        else throw new PeerSendError('usage');
        console.log(JSON.stringify(result));
        return ['admitted', 'status'].includes(result.outcome) && !['failed', 'expired'].includes(result.execution) ? 0 : 1;
    } catch (error) {
        console.log(JSON.stringify({ outcome: 'local_error', code: error instanceof PeerSendError ? error.code : 'local_failure',
            ...(error instanceof PeerSendError && error.savedFile ? { savedFile: error.savedFile } : {}) }));
        return 2;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    process.exitCode = await main();
}
