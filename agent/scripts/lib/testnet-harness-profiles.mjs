const HARNESS_PROFILE_DEFINITIONS = Object.freeze({
    'local-mock': Object.freeze({
        name: 'local-mock',
        mode: 'local',
        chainId: 31337,
        rpcEnv: null,
        forkRpcEnv: null,
        managesLocalNode: true,
    }),
    'fork-sepolia': Object.freeze({
        name: 'fork-sepolia',
        mode: 'fork',
        chainId: 11155111,
        rpcEnv: 'SEPOLIA_RPC_URL',
        forkRpcEnv: 'SEPOLIA_RPC_URL',
        managesLocalNode: true,
    }),
    'fork-polygon': Object.freeze({
        name: 'fork-polygon',
        mode: 'fork',
        chainId: 137,
        rpcEnv: 'POLYGON_RPC_URL',
        forkRpcEnv: 'POLYGON_RPC_URL',
        managesLocalNode: true,
    }),
    'remote-sepolia': Object.freeze({
        name: 'remote-sepolia',
        mode: 'remote',
        chainId: 11155111,
        rpcEnv: 'SEPOLIA_RPC_URL',
        forkRpcEnv: null,
        managesLocalNode: false,
    }),
});

function listHarnessProfiles() {
    return Object.values(HARNESS_PROFILE_DEFINITIONS).map((profile) => ({
        name: profile.name,
        mode: profile.mode,
        chainId: profile.chainId,
        rpcEnv: profile.rpcEnv,
        forkRpcEnv: profile.forkRpcEnv,
        managesLocalNode: profile.managesLocalNode,
    }));
}

function resolveHarnessProfile(profileName, { env = process.env } = {}) {
    const profile = HARNESS_PROFILE_DEFINITIONS[profileName];
    if (!profile) {
        const supportedProfiles = Object.keys(HARNESS_PROFILE_DEFINITIONS).join(', ');
        throw new Error(
            `Unknown harness profile "${profileName}". Supported profiles: ${supportedProfiles}.`
        );
    }

    const rpcUrlRaw = profile.rpcEnv ? env?.[profile.rpcEnv] : undefined;
    const rpcUrl = typeof rpcUrlRaw === 'string' ? rpcUrlRaw.trim() : '';
    if (profile.rpcEnv && !rpcUrl) {
        throw new Error(
            `Harness profile "${profileName}" requires ${profile.rpcEnv} in the environment.`
        );
    }

    return {
        ...profile,
        rpcConfigured: Boolean(rpcUrl),
        rpcUrl: rpcUrl || undefined,
        forkConfigured: Boolean(profile.forkRpcEnv && rpcUrl),
        forkUrl: profile.forkRpcEnv ? rpcUrl || undefined : undefined,
    };
}

export {
    HARNESS_PROFILE_DEFINITIONS,
    listHarnessProfiles,
    resolveHarnessProfile,
};
