async function readJsonBody(req, { maxBytes }) {
    const chunks = [];
    let total = 0;

    for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) {
            const error = new Error(`Request body exceeds ${maxBytes} bytes.`);
            error.code = 'body_too_large';
            throw error;
        }
        chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) {
        return {};
    }

    try {
        return JSON.parse(raw);
    } catch (error) {
        const parseError = new Error('Malformed JSON body.');
        parseError.code = 'invalid_json';
        throw parseError;
    }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders,
    });
    res.end(JSON.stringify(payload));
}

export { readJsonBody, sendJson };
