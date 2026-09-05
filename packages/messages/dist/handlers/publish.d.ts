import type { PublishToIpfsOptions, PublishToIpfsResult } from '@oyaprotocol/ipfs';
import type { SignedMessageInput } from '../schema.js';
type PublishSignedMessageOptions = Pick<PublishToIpfsOptions, 'config' | 'fetch' | 'signal'>;
declare function publishSignedMessage(input: Readonly<SignedMessageInput>, options: PublishSignedMessageOptions): Promise<PublishToIpfsResult>;
export { publishSignedMessage };
export type { PublishSignedMessageOptions };
