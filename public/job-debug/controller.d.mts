export function createRefreshLoop<T>(options: {
  load: (key: string, signal: AbortSignal) => Promise<T>;
  onData: (data: T) => void;
  onError?: (error: Error) => void;
  intervalMs?: number;
}): {
  start: (key: string) => void;
  refresh: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
};
