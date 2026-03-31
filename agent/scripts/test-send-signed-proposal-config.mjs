import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import {
    buildProposalPublishBaseUrl,
    resolveProposalPublishApiTarget,
    resolveProposalPublishServerConfig,
} from './lib/proposal-publish-runtime.mjs';

async function createAgentModule(repoRootPath, name, config, localConfig) {
    const agentDir = path.join(repoRootPath, 'agent-library', 'agents', name);
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, 'agent.js'), 'export default {};\n', 'utf8');
    await writeFile(
        path.join(agentDir, 'config.json'),
        JSON.stringify(config, null, 2),
        'utf8'
    );
    await writeFile(path.join(agentDir, 'commitment.txt'), 'test commitment\n', 'utf8');
    if (localConfig !== undefined) {
        await writeFile(
            path.join(agentDir, 'config.local.json'),
            JSON.stringify(localConfig, null, 2),
            'utf8'
        );
    }
}

async function run() {
    const repoRootPath = await mkdtemp(path.join(os.tmpdir(), 'send-signed-proposal-'));

    await createAgentModule(
        repoRootPath,
        'single-chain',
        {
            chainId: 11155111,
            rpcUrl: 'https://rpc.sepolia.example',
            proposalPublishApi: {
                enabled: true,
                host: 'config-host.local',
                port: 7777,
                requireSignerAllowlist: false,
            },
            byChain: {
                '11155111': {
                    proposalPublishApi: {
                        port: 9898,
                    },
                },
            },
        },
        {
            byChain: {
                '11155111': {
                    proposalPublishApi: {
                        host: 'local-host.local',
                    },
                },
            },
        }
    );

    const overlayPath = path.join(repoRootPath, 'overlay.json');
    await writeFile(
        overlayPath,
        JSON.stringify(
            {
                byChain: {
                    '11155111': {
                        proposalPublishApi: {
                            port: 9444,
                            stateFile: 'agent/.state/proposal-publications/overlay-state.json',
                        },
                    },
                },
            },
            null,
            2
        ),
        'utf8'
    );

    await assert.rejects(
        () =>
            buildProposalPublishBaseUrl({
                argv: ['node', 'send-signed-proposal.mjs', '--url=http://cli-host:9555'],
                env: {},
                repoRootPath,
            }),
        /--url requires --chain-id or --module/
    );

    assert.equal(
        await buildProposalPublishBaseUrl({
            argv: ['node', 'send-signed-proposal.mjs', '--module=single-chain'],
            env: {},
            repoRootPath,
        }),
        'http://local-host.local:9898'
    );

    const directUrlWithModuleTarget = await resolveProposalPublishApiTarget({
        argv: [
            'node',
            'send-signed-proposal.mjs',
            '--module=single-chain',
            '--url=http://cli-host:9555',
        ],
        env: {},
        repoRootPath,
    });
    assert.equal(directUrlWithModuleTarget.baseUrl, 'http://cli-host:9555');
    assert.equal(directUrlWithModuleTarget.chainId, 11155111);

    const directUrlWithChainTarget = await resolveProposalPublishApiTarget({
        argv: [
            'node',
            'send-signed-proposal.mjs',
            '--url=http://cli-host:9555',
            '--chain-id=11155111',
        ],
        env: {},
        repoRootPath,
    });
    assert.equal(directUrlWithChainTarget.baseUrl, 'http://cli-host:9555');
    assert.equal(directUrlWithChainTarget.chainId, 11155111);

    await createAgentModule(repoRootPath, 'no-chain', {
        proposalPublishApi: {
            enabled: true,
            host: 'no-chain-host.local',
            port: 9797,
            requireSignerAllowlist: false,
        },
    });

    await assert.rejects(
        () =>
            buildProposalPublishBaseUrl({
                argv: [
                    'node',
                    'send-signed-proposal.mjs',
                    '--module=no-chain',
                    '--url=http://cli-host:9555',
                ],
                env: {},
                repoRootPath,
            }),
        /Unable to infer chainId for explicit --url from module "no-chain"/
    );

    assert.equal(
        await buildProposalPublishBaseUrl({
            argv: [
                'node',
                'send-signed-proposal.mjs',
                '--module=single-chain',
                `--overlay=${overlayPath}`,
            ],
            env: {},
            repoRootPath,
        }),
        'http://local-host.local:9444'
    );

    assert.equal(
        await buildProposalPublishBaseUrl({
            argv: ['node', 'send-signed-proposal.mjs', '--module=single-chain'],
            env: {
                AGENT_CONFIG_OVERLAY_PATH: overlayPath,
            },
            repoRootPath,
        }),
        'http://local-host.local:9898'
    );

    assert.equal(
        await buildProposalPublishBaseUrl({
            argv: [
                'node',
                'send-signed-proposal.mjs',
                '--module=single-chain',
                '--scheme=https',
                '--port=9443',
            ],
            env: {},
            repoRootPath,
        }),
        'https://local-host.local:9443'
    );

    const serverConfig = await resolveProposalPublishServerConfig({
        argv: ['node', 'start-proposal-publish-node.mjs', '--module=single-chain'],
        env: {},
        repoRootPath,
    });
    assert.equal(serverConfig.runtimeConfig.proposalPublishApiEnabled, true);
    assert.equal(serverConfig.runtimeConfig.proposalPublishApiMode, 'publish');
    assert.equal(
        serverConfig.stateFile,
        path.join(
            repoRootPath,
            'agent',
            '.state',
            'proposal-publications',
            'single-chain-chain-11155111.json'
        )
    );

    const overlaidServerConfig = await resolveProposalPublishServerConfig({
        argv: [
            'node',
            'start-proposal-publish-node.mjs',
            '--module=single-chain',
            `--overlay=${overlayPath}`,
        ],
        env: {},
        repoRootPath,
    });
    assert.equal(
        overlaidServerConfig.stateFile,
        path.join(repoRootPath, 'agent/.state/proposal-publications/overlay-state.json')
    );

    await createAgentModule(repoRootPath, 'multichain-server', {
        proposalPublishApi: {
            enabled: true,
            host: 'multichain-host.local',
            port: 9790,
            requireSignerAllowlist: false,
        },
        byChain: {
            '11155111': {
                commitmentSafe: '0x1111111111111111111111111111111111111111',
            },
            '137': {
                commitmentSafe: '0x2222222222222222222222222222222222222222',
            },
        },
    });

    const multichainServerConfig = await resolveProposalPublishServerConfig({
        argv: ['node', 'start-proposal-publish-node.mjs', '--module=multichain-server'],
        env: {},
        repoRootPath,
    });
    assert.equal(multichainServerConfig.runtimeConfig.chainId, undefined);
    assert.equal(multichainServerConfig.runtimeConfig.proposalPublishApiHost, 'multichain-host.local');
    assert.equal(multichainServerConfig.runtimeConfig.proposalPublishApiPort, 9790);
    assert.equal(multichainServerConfig.runtimeConfig.proposalPublishApiMode, 'publish');
    assert.equal(
        multichainServerConfig.stateFile,
        path.join(
            repoRootPath,
            'agent',
            '.state',
            'proposal-publications',
            'multichain-server-chain-unknown.json'
        )
    );

    await createAgentModule(repoRootPath, 'ambiguous', {
        byChain: {
            '11155111': {
                proposalPublishApi: {
                    enabled: true,
                    host: 'sepolia-host.local',
                    port: 9891,
                    requireSignerAllowlist: false,
                },
            },
            '137': {
                proposalPublishApi: {
                    enabled: true,
                    host: 'polygon-host.local',
                    port: 9892,
                    requireSignerAllowlist: false,
                },
            },
        },
    });
    assert.deepEqual(multichainServerConfig.supportedChainIds.sort((left, right) => left - right), [
        137,
        11155111,
    ]);

    await createAgentModule(repoRootPath, 'multichain-propose', {
        proposalPublishApi: {
            enabled: true,
            mode: 'propose',
            host: 'multichain-propose.local',
            port: 9791,
            requireSignerAllowlist: false,
        },
        byChain: {
            '11155111': {
                rpcUrl: 'https://rpc.sepolia.example',
                proposeEnabled: true,
            },
            '137': {
                rpcUrl: 'https://rpc.polygon.example',
                proposeEnabled: true,
            },
        },
    });

    const multichainProposeServerConfig = await resolveProposalPublishServerConfig({
        argv: ['node', 'start-proposal-publish-node.mjs', '--module=multichain-propose'],
        env: {},
        repoRootPath,
    });
    assert.equal(multichainProposeServerConfig.runtimeConfig.chainId, undefined);
    assert.equal(multichainProposeServerConfig.runtimeConfig.proposalPublishApiMode, 'propose');
    assert.deepEqual(
        multichainProposeServerConfig.supportedChainIds.sort((left, right) => left - right),
        [137, 11155111]
    );

    await createAgentModule(repoRootPath, 'broken-propose', {
        proposalPublishApi: {
            enabled: true,
            mode: 'propose',
            host: 'broken-propose.local',
            port: 9792,
            requireSignerAllowlist: false,
        },
        byChain: {
            '11155111': {
                proposeEnabled: false,
            },
            '137': {
                proposalPublishApi: {
                    enabled: false,
                },
                proposeEnabled: true,
            },
        },
    });

    await assert.rejects(
        () =>
            resolveProposalPublishServerConfig({
                argv: ['node', 'start-proposal-publish-node.mjs', '--module=broken-propose'],
                env: {},
                repoRootPath,
            }),
        /does not resolve any propose-capable chain runtime/
    );

    await createAgentModule(repoRootPath, 'broken-propose-no-rpc', {
        proposalPublishApi: {
            enabled: true,
            mode: 'propose',
            host: 'broken-propose-no-rpc.local',
            port: 9793,
            requireSignerAllowlist: false,
        },
        byChain: {
            '11155111': {
                proposeEnabled: true,
            },
            '137': {
                proposeEnabled: true,
            },
        },
    });

    await assert.rejects(
        () =>
            resolveProposalPublishServerConfig({
                argv: ['node', 'start-proposal-publish-node.mjs', '--module=broken-propose-no-rpc'],
                env: {},
                repoRootPath,
            }),
        /does not resolve any propose-capable chain runtime/
    );

    await assert.rejects(
        () =>
            buildProposalPublishBaseUrl({
                argv: ['node', 'send-signed-proposal.mjs', '--module=ambiguous'],
                env: {},
                repoRootPath,
            }),
        /defines multiple byChain entries .* but no top-level chainId/
    );

    assert.equal(
        await buildProposalPublishBaseUrl({
            argv: [
                'node',
                'send-signed-proposal.mjs',
                '--module=ambiguous',
                '--chain-id=11155111',
            ],
            env: {},
            repoRootPath,
        }),
        'http://sepolia-host.local:9891'
    );

    await createAgentModule(repoRootPath, 'disabled-publication', {
        chainId: 11155111,
        proposalPublishApi: {
            enabled: false,
            requireSignerAllowlist: false,
        },
    });

    await assert.rejects(
        () =>
            buildProposalPublishBaseUrl({
                argv: ['node', 'send-signed-proposal.mjs', '--module=disabled-publication'],
                env: {},
                repoRootPath,
            }),
        /does not enable proposalPublishApi/
    );

    await assert.rejects(
        () =>
            buildProposalPublishBaseUrl({
                argv: [
                    'node',
                    'send-signed-proposal.mjs',
                    '--module=disabled-publication',
                    '--scheme=https',
                ],
                env: {},
                repoRootPath,
            }),
        /does not enable proposalPublishApi/
    );

    assert.equal(
        await buildProposalPublishBaseUrl({
            argv: [
                'node',
                'send-signed-proposal.mjs',
                '--module=disabled-publication',
                '--host=manual-host.local',
                '--port=9895',
                '--scheme=https',
            ],
            env: {},
            repoRootPath,
        }),
        'https://manual-host.local:9895'
    );

    console.log('[test] send signed proposal config OK');
}

run().catch((error) => {
    console.error('[test] send signed proposal config failed:', error?.message ?? error);
    process.exit(1);
});
