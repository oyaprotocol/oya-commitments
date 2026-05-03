function assertAsciiBytes(bytes, message) {
    for (const byte of bytes) {
        if (byte > 0x7f) {
            throw new Error(message);
        }
    }
}
export { assertAsciiBytes };
//# sourceMappingURL=validation-utils.js.map