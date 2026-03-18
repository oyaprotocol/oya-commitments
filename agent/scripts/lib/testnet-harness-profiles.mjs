const HARNESS_PROFILE_DEFINITIONS = Object.freeze({
    'local-mock': Object.freeze({
        name: 'local-mock',
        mode: 'local',
        chainId: 31337,
        forkRpcEnv: null,
    }),
    'fork-sepolia': Object.freeze({
        name: 'fork-sepolia',
        mode: 'fork',
        chainId: 11155111,
        forkRpcEnv: 'SEPOLIA_RPC_URL',
    }),
    'fork-polygon': Object.freeze({
        name: 'fork-polygon',
        mode: 'fork',
        chainId: 137,
        forkRpcEnv: 'POLYGON_RPC_URL',
    }),
});

function listHarnessProfiles() {
    return Object.values(HARNESS_PROFILE_DEFINITIONS).map((profile) => ({
        name: profile.name,
        mode: profile.mode,
        chainId: profile.chainId,
        forkRpcEnv: profile.forkRpcEnv,
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

    const forkUrlRaw = profile.forkRpcEnv ? env?.[profile.forkRpcEnv] : undefined;
    const forkUrl = typeof forkUrlRaw === 'string' ? forkUrlRaw.trim() : '';
    if (profile.forkRpcEnv && !forkUrl) {
        throw new Error(
            `Harness profile "${profileName}" requires ${profile.forkRpcEnv} in the environment.`
        );
    }

    return {
        ...profile,
        forkConfigured: Boolean(forkUrl),
        forkUrl: forkUrl || undefined,
    };
}

export {
    HARNESS_PROFILE_DEFINITIONS,
    listHarnessProfiles,
    resolveHarnessProfile,
};
