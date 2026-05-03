function assertAsciiBytes(bytes: Uint8Array, message: string): void {
    for (const byte of bytes) {
        if (byte > 0x7f) {
            throw new Error(message);
        }
    }
}

export { assertAsciiBytes };
