import type { MeasurementScope } from "./measurement";

/**
 * Wraps a repositories object so every method call is timed under the `db`
 * prefix. Applied per unit of work rather than at the composition root, because
 * both service containers are process-wide singletons and a shared wrapper
 * could not attribute a query to the request that caused it.
 *
 * A Proxy keeps `packages/database/src/postgres-repositories.ts` untouched.
 */
export function measuredRepositories<T extends object>(
  repositories: T,
  scope: MeasurementScope
): T {
  const wrapped = new Map<string | symbol, unknown>();

  return new Proxy(repositories, {
    get(target, property, receiver) {
      const group = Reflect.get(target, property, receiver);
      if (typeof group !== "object" || group === null) return group;
      if (wrapped.has(property)) return wrapped.get(property);

      const measuredGroup = new Proxy(group as object, {
        get(groupTarget, method, groupReceiver) {
          const value = Reflect.get(groupTarget, method, groupReceiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) =>
            scope.time("db", async () =>
              (value as (...inner: unknown[]) => unknown).apply(
                groupTarget,
                args
              )
            );
        }
      });

      wrapped.set(property, measuredGroup);
      return measuredGroup;
    }
  }) as T;
}
