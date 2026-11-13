import { comparePeerDirectories, DirectoryError, inspectPeerDirectory, loadPeerDirectory } from '../src/peers/directory.mjs';

const [command, ...paths] = process.argv.slice(2);
if (!((command === 'inspect' && paths.length === 1) || (command === 'compare' && paths.length === 2))) {
    console.error(JSON.stringify({ error: 'usage', usage: 'peer-directory.mjs inspect FILE | compare BASE CANDIDATE' }));
    process.exitCode = 2;
} else {
    try {
        const first = loadPeerDirectory(paths[0]);
        let report;
        if (command === 'inspect') report = { ...inspectPeerDirectory(first.directory), fileSha256: first.fileSha256 };
        else {
            const second = loadPeerDirectory(paths[1]);
            report = { ...comparePeerDirectories(first.directory, second.directory),
                baseFileSha256: first.fileSha256, fileSha256: second.fileSha256,
                contentSha256: inspectPeerDirectory(second.directory).contentSha256 };
        }
        console.log(JSON.stringify(report, null, 2));
    } catch (error) {
        console.error(JSON.stringify({ error: error instanceof DirectoryError ? error.code : 'directory_inspection_failed' }));
        process.exitCode = 1;
    }
}
