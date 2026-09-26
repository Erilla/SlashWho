import { useEffect, useRef } from "react";

const cappedDelayMs = 10_000;
/** How long each successive read waits, holding at the last delay. */
export const pollDelaysMs: readonly number[] = [
  1_000,
  2_000,
  4_000,
  8_000,
  cappedDelayMs
];

/**
 * A backoff over `delays`: each `next()` returns the following delay, and the
 * last one repeats once the schedule runs out.
 */
export function createBackoff(delays: readonly number[] = pollDelaysMs): {
  next(): number;
} {
  let attempt = 0;
  return {
    next() {
      const delay =
        delays[Math.min(attempt, delays.length - 1)] ?? cappedDelayMs;
      attempt += 1;
      return delay;
    }
  };
}

export type PollReadResult<T> =
  | { kind: "snapshot"; value: T }
  | { kind: "retry"; retryAfterMs?: number }
  | { kind: "terminal"; response: Response };

export interface AuthoritativePollOptions<T> {
  active: boolean;
  read(signal: AbortSignal): Promise<PollReadResult<T>>;
  onSnapshot(snapshot: T): void;
  onTerminalError(response: Response): void;
}

export function retryAfterMilliseconds(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const retryAt = Date.parse(retryAfter);
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now())
    : undefined;
}

export function useAuthoritativePoll<T>(
  options: AuthoritativePollOptions<T>
): void {
  const optionsRef = useRef(options);
  const generationRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const controllerRef = useRef<AbortController | undefined>(undefined);

  optionsRef.current = options;

  useEffect(() => {
    let mounted = true;
    let terminal = false;
    const backoff = createBackoff();

    function clearScheduledRead() {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }

    function invalidateRead() {
      generationRef.current += 1;
      clearScheduledRead();
      controllerRef.current?.abort();
      controllerRef.current = undefined;
    }

    function scheduleRead(delay: number) {
      if (
        !mounted ||
        terminal ||
        !optionsRef.current.active ||
        document.visibilityState === "hidden"
      ) {
        return;
      }

      clearScheduledRead();
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = undefined;
        void readSnapshot();
      }, delay);
    }

    function retryDelay(retryAfterMs: number | undefined) {
      return Number.isFinite(retryAfterMs) &&
        retryAfterMs !== undefined &&
        retryAfterMs >= 0
        ? retryAfterMs
        : cappedDelayMs;
    }

    async function readSnapshot() {
      if (
        !mounted ||
        terminal ||
        !optionsRef.current.active ||
        document.visibilityState === "hidden" ||
        controllerRef.current
      ) {
        return;
      }

      const controller = new AbortController();
      controllerRef.current = controller;
      const generation = ++generationRef.current;

      try {
        const result = await optionsRef.current.read(controller.signal);
        if (
          !mounted ||
          controller.signal.aborted ||
          generation !== generationRef.current
        ) {
          return;
        }

        if (result.kind === "snapshot") {
          optionsRef.current.onSnapshot(result.value);
          scheduleRead(backoff.next());
          return;
        }

        if (result.kind === "terminal") {
          terminal = true;
          optionsRef.current.onTerminalError(result.response);
          return;
        }

        scheduleRead(retryDelay(result.retryAfterMs));
      } catch {
        if (
          mounted &&
          !controller.signal.aborted &&
          generation === generationRef.current
        ) {
          scheduleRead(cappedDelayMs);
        }
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = undefined;
        }
      }
    }

    function onVisibilityChange() {
      if (terminal || !optionsRef.current.active) return;

      if (document.visibilityState === "hidden") {
        clearScheduledRead();
        return;
      }

      invalidateRead();
      void readSnapshot();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    if (options.active && document.visibilityState !== "hidden") {
      scheduleRead(backoff.next());
    }

    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      invalidateRead();
    };
  }, [options.active]);
}
