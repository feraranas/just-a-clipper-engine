// A single scheduled request, guarded by both AbortSignal and selection generation.
export function createRefreshLoop({
  load,
  onData,
  onError = () => {},
  intervalMs = 2000,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let key,
    generation = 0,
    timer,
    controller,
    active = false,
    paused = false,
    stopped = false;
  const reset = () => {
    generation++;
    cancel(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
    active = false;
  };
  const tick = async () => {
    if (stopped || paused || active || key === undefined) return;
    cancel(timer);
    timer = undefined;
    active = true;
    const version = generation,
      request = new AbortController();
    controller = request;
    try {
      const data = await load(key, request.signal);
      if (version === generation && !request.signal.aborted) onData(data);
    } catch (error) {
      if (version === generation && !request.signal.aborted) onError(error);
    } finally {
      if (version === generation) {
        active = false;
        if (!stopped && !paused) timer = schedule(tick, intervalMs);
      }
    }
  };
  return {
    start(next) {
      reset();
      key = next;
      stopped = false;
      void tick();
    },
    refresh() {
      void tick();
    },
    pause() {
      paused = true;
      reset();
    },
    resume() {
      if (stopped) return;
      paused = false;
      void tick();
    },
    stop() {
      stopped = true;
      reset();
    },
  };
}
