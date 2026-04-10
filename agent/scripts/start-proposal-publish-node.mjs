import { isDirectScriptExecution } from './lib/cli-runtime.mjs';
import { main } from './lib/start-proposal-publish-node-main.mjs';

if (isDirectScriptExecution(import.meta.url)) {
    main().catch((error) => {
        console.error('[oya-node] start proposal publish node failed:', error?.message ?? error);
        process.exit(1);
    });
}

export { main };
