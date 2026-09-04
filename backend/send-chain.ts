/**
 * SendChain — serializes outbound message sends so chunks of a streaming reply
 * arrive in order. Each send is retried once; a send that fails twice is kept
 * in `failed` so the caller can fold it into the final message instead of
 * silently losing it.
 */

export interface SendChainResult {
  sent: number;
  failed: string[];
}

export type ChainSendFn = (text: string) => Promise<unknown>;

export interface SendChain {
  /** Queue a text; resolves when this text's send attempt(s) completed. */
  enqueue(text: string): Promise<void>;
  /** Wait for every queued send to settle. */
  settle(): Promise<SendChainResult>;
}

export interface SendChainOptions {
  retries?: number;
  onError?: (text: string, err: unknown, attempt: number) => void;
}

async function attemptSend(
  send: ChainSendFn,
  text: string,
  retries: number,
  onError?: SendChainOptions["onError"],
): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await send(text);
      return true;
    } catch (err) {
      onError?.(text, err, attempt);
    }
  }
  return false;
}

export function createSendChain(send: ChainSendFn, opts: SendChainOptions = {}): SendChain {
  const retries = opts.retries ?? 1;
  let tail: Promise<void> = Promise.resolve();
  let sent = 0;
  let failed: string[] = [];

  const enqueue = (text: string): Promise<void> => {
    const next = tail.then(async () => {
      const ok = await attemptSend(send, text, retries, opts.onError);
      if (ok) sent += 1;
      else failed = [...failed, text];
    });
    tail = next;
    return next;
  };

  const settle = async (): Promise<SendChainResult> => {
    await tail;
    return { sent, failed: [...failed] };
  };

  return { enqueue, settle };
}
