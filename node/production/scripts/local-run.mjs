import { spawn as spawnChild } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { localUrl } from './local-config.mjs';

const entrypoint = fileURLToPath(new URL('../src/main.mjs', import.meta.url));

export function runLocalNode(configPath, { config, nodeEnv }, { spawn = spawnChild, log = console.log } = {}) {
    log(`Starting node at ${localUrl(config)}. Press Ctrl-C to drain and stop.`);
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(process.execPath, ['--', entrypoint, configPath], { env: nodeEnv, stdio: 'inherit' });
        } catch {
            log('FAIL Could not launch the node process. Check the Node.js installation.');
            resolve(1);
            return;
        }
        let stopping = false;
        let failed = false;
        const stop = (signal) => {
            if (stopping) return;
            stopping = true;
            log('Stopping node; waiting for active work to finish.');
            child.kill(signal);
        };
        const interrupt = () => stop('SIGINT');
        const terminate = () => stop('SIGTERM');
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', terminate);
        child.once('error', () => {
            failed = true;
            log('FAIL Node process error. Check the Node.js installation.');
        });
        child.once('close', (code, signal) => {
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', terminate);
            resolve(failed ? 1 : code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
        });
    });
}
