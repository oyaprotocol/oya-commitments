import { encodeLedgerCall, decodeLedgerEvent, hashLedgerCid } from '@oyaprotocol/ethereum';
import type {
    EthereumReceiptLog,
    LedgerEvent,
    LedgerEventInput,
} from '@oyaprotocol/ethereum';

const calldata: string = encodeLedgerCall('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
declare const ledgerContract: string;
const cidKeccak256Hash: string = hashLedgerCid('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
declare const receiptLog: EthereumReceiptLog;
const input: LedgerEventInput = receiptLog;
const event: LedgerEvent | null = decodeLedgerEvent(input, ledgerContract);
if (event !== null) {
    const node: string = event.node;
    const cidKeccak256Hash: string = event.cidKeccak256Hash;
    const cid: string = event.cid;
    const removed: boolean | undefined = event.removed;
    // @ts-expect-error Decoded event values are readonly.
    event.cid = 'changed';
    // @ts-expect-error Decoded hash values are readonly.
    event.cidKeccak256Hash = 'changed';
    void [node, cidKeccak256Hash, cid, removed];
}

// @ts-expect-error Call encoding requires a string.
encodeLedgerCall(1);
// @ts-expect-error Decoding requires an explicit expected Ledger address.
decodeLedgerEvent(receiptLog);
// @ts-expect-error Event filtering can return null.
const matchingEvent: LedgerEvent = decodeLedgerEvent(receiptLog, ledgerContract);
void [calldata, cidKeccak256Hash, matchingEvent];
