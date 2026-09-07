import { Wallet, keccak256 } from 'ethers';

export function createLocalSigner(privateKey) {
    let wallet;
    try {
        if (typeof privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error();
        wallet = new Wallet(privateKey);
    } catch {
        throw new Error('OYA_NODE_PRIVATE_KEY must contain a valid Ethereum private key.');
    }
    return Object.freeze({
        address: wallet.address,
        async signTransaction(transaction, signal) {
            signal?.throwIfAborted();
            const rawTransaction = await wallet.signTransaction({ ...transaction, accessList: [] });
            signal?.throwIfAborted();
            return { rawTransaction, transactionHash: keccak256(rawTransaction) };
        },
    });
}
