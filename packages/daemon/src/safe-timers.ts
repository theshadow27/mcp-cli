type TimerCallback = () => void | Promise<void>;
type ErrorHandler = (error: unknown) => void;

function defaultErrorHandler(error: unknown): void {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[safe-timer] unhandled error in timer callback: ${msg}`);
}

function safeInvokeHandler(onError: ErrorHandler, error: unknown): void {
  try {
    onError(error);
  } catch (handlerError) {
    defaultErrorHandler(error);
    defaultErrorHandler(handlerError);
  }
}

function wrapCallback(fn: TimerCallback, onError: ErrorHandler): () => void {
  return () => {
    try {
      const result = fn();
      if (result && typeof result.then === "function") {
        result.then(undefined, (e: unknown) => safeInvokeHandler(onError, e));
      }
    } catch (e) {
      safeInvokeHandler(onError, e);
    }
  };
}

export function safeSetTimeout(fn: TimerCallback, ms: number, onError?: ErrorHandler): ReturnType<typeof setTimeout> {
  return setTimeout(wrapCallback(fn, onError ?? defaultErrorHandler), ms);
}

export function safeSetInterval(fn: TimerCallback, ms: number, onError?: ErrorHandler): ReturnType<typeof setInterval> {
  return setInterval(wrapCallback(fn, onError ?? defaultErrorHandler), ms);
}
