import { renderCodexImage } from './codex-imagegen.js';

/** One daemon owns all of its Codex renders, including readiness in flight. */
export function createCodexImageService(renderImage = renderCodexImage) {
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let shutdown: Promise<void> | undefined;
  const render: typeof renderCodexImage = input => {
    if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
    const result = renderImage({ ...input, signal: controller.signal });
    pending.add(result);
    void result.then(() => pending.delete(result), () => pending.delete(result));
    return result;
  };
  return {
    render,
    shutdownActive(): Promise<void> {
      if (!shutdown) {
        controller.abort(new Error('Codex image generation canceled by daemon shutdown'));
        shutdown = Promise.allSettled([...pending]).then(() => {});
      }
      return shutdown;
    },
  };
}
