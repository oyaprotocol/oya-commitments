import { isDirectScriptExecution } from './lib/cli-runtime.mjs';
import { main } from '../../node/scripts/start-message-publish-node.mjs';

if (isDirectScriptExecution(import.meta.url)) {
    main().catch((error) => {
        console.error('[oya-node] start message publish node failed:', error?.message ?? error);
        process.exit(1);
    });
}

export { main };
