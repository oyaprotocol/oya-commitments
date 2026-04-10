import {
    isDirectScriptExecution,
} from './lib/cli-runtime.mjs';
import { importAgentModule } from './lib/shared-agent-import.mjs';
const { main } = await importAgentModule(
    new URL('../../agent/scripts/lib/start-proposal-publish-node-main.mjs', import.meta.url).href,
    'scripts/lib/start-proposal-publish-node-main.mjs'
);

if (isDirectScriptExecution(import.meta.url)) {
    main().catch((error) => {
        console.error('[oya-node] start proposal publish node failed:', error?.message ?? error);
        process.exit(1);
    });
}

export { main };
