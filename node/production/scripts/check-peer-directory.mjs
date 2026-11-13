import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { comparePeerDirectories, decodePeerDirectory, DirectoryError, inspectPeerDirectory,
    loadPeerDirectory, MAX_DIRECTORY_BYTES } from '../src/peers/directory.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const registry = 'node/production/peers/testnet-directory.json';
const args = process.argv.slice(2);
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: MAX_DIRECTORY_BYTES + 1024, stdio: ['ignore', 'pipe', 'pipe'] });
try {
    if (args.length > 1 || (args.length === 1 && !/^[0-9a-f]{40}$(?![\s\S])/.test(args[0]))) {
        console.error(JSON.stringify({ error: 'usage', usage: 'check-peer-directory.mjs [BASE_COMMIT_SHA]' }));
        process.exitCode = 2;
    } else {
        const candidate = loadPeerDirectory(fileURLToPath(new URL('../peers/testnet-directory.json', import.meta.url)));
        let comparison = null;
        if (args.length) {
            const base = args[0];
            git('cat-file', '-e', `${base}^{commit}`);
            const entry = git('ls-tree', base, '--', registry).toString('utf8').trim();
            if (!entry) {
                if (candidate.directory.revision !== 1 || candidate.directory.nodes.length !== 0)
                    throw new DirectoryError('initial_directory_must_be_empty_revision_one');
                comparison = { initialDirectory: true };
            } else {
                if (!/^100(?:644|755) blob /.test(entry)) throw new DirectoryError('invalid_base_directory_mode');
                const bytes = git('show', `${base}:${registry}`);
                comparison = comparePeerDirectories(decodePeerDirectory(bytes).directory, candidate.directory);
            }
        }
        console.log(JSON.stringify({ ...inspectPeerDirectory(candidate.directory), fileSha256: candidate.fileSha256,
            comparison }, null, 2));
    }
} catch (error) {
    console.error(JSON.stringify({ error: error instanceof DirectoryError ? error.code : 'directory_base_unavailable' }));
    process.exitCode = 1;
}
