async function importAgentModule(localSpecifier, packageSubpath) {
    try {
        return await import(localSpecifier);
    } catch (error) {
        if (error?.code !== 'ERR_MODULE_NOT_FOUND') {
            throw error;
        }
        return import(`og-commitment-agent/${packageSubpath}`);
    }
}

export { importAgentModule };
