import { Data, Effect } from "effect";

export class BridgeError extends Data.TaggedError("BridgeError")<{
  message: string;
  cause?: unknown;
}> {}

export function attempt<A>(message: string, run: (signal: AbortSignal) => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause instanceof BridgeError ? cause : new BridgeError({
      message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    }),
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
