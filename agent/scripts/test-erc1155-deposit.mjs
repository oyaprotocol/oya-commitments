import assert from 'node:assert/strict';
import { makeErc1155Deposit } from '../src/lib/tx.js';

async function run() {
    const token = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
    const account = { address: '0x1111111111111111111111111111111111111111' };
    const config = { commitmentSafe: '0x2222222222222222222222222222222222222222' };

    let writeContractArgs;
    const walletClient = {
        async writeContract(args) {
            writeContractArgs = args;
            return '0xabc123';
        },
    };

    const txHash = await makeErc1155Deposit({
        walletClient,
        account,
        config,
        token,
        tokenId: '7',
        amount: '3',
        data: null,
    });

    assert.equal(txHash, '0xabc123');
    assert.equal(writeContractArgs.address.toLowerCase(), token.toLowerCase());
    assert.equal(writeContractArgs.functionName, 'safeTransferFrom');
    assert.equal(writeContractArgs.args[0].toLowerCase(), account.address.toLowerCase());
    assert.equal(writeContractArgs.args[1].toLowerCase(), config.commitmentSafe.toLowerCase());
    assert.equal(writeContractArgs.args[2], 7n);
    assert.equal(writeContractArgs.args[3], 3n);
    assert.equal(writeContractArgs.args[4], '0x');

    await assert.rejects(
        () =>
            makeErc1155Deposit({
                walletClient,
                account,
                config,
                token,
                tokenId: '7',
                amount: '0',
                data: '0x',
            }),
        /amount must be > 0/
    );

    console.log('[test] makeErc1155Deposit OK');
}

run();
