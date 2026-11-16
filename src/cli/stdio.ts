// A closed pipe only ends display, never an in-flight state transition. In
// particular, do not process.exit() from the stream's asynchronous error event.
export function outputWriter(stream: NodeJS.WritableStream) {
  const closed = new AbortController();
  const onError = (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
    closed.abort();
  };
  // Keep listening until process shutdown: an error may arrive after the command
  // promise resolves, and already queued writes may emit more than one error.
  stream.on("error", onError);
  let sink: ((text: string) => void) | undefined;
  const raw = (text: string): void => {
    if (closed.signal.aborted) return;
    try {
      stream.write(text);
    } catch (error) {
      onError(error as NodeJS.ErrnoException);
    }
  };
  return {
    signal: closed.signal,
    write: (text: string): void => {
      if (sink) sink(text);
      else raw(text + "\n");
    },
    /** Write as is: the escape sequences of a live frame carry their own positioning. */
    raw,
    /** Route write() into `into` (a live frame's notices) until the returned function is called. */
    capture(into: (text: string) => void): () => void {
      const previous = sink;
      sink = into;
      return () => {
        sink = previous;
      };
    },
  };
}

export const stdout = outputWriter(process.stdout);
export const stderr = outputWriter(process.stderr);
export const outputClosed = AbortSignal.any([stdout.signal, stderr.signal]);
