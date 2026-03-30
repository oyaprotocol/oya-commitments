function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalizeJson(value) {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalizeJson(item));
    }
    if (isPlainObject(value)) {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = canonicalizeJson(value[key]);
        }
        return out;
    }
    return value;
}

function stringifyCanonicalJson(value) {
    return JSON.stringify(canonicalizeJson(value));
}

export { canonicalizeJson, isPlainObject, stringifyCanonicalJson };
