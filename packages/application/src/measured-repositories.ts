import type { MeasurementScope } from "./measurement";

/**
 * Wraps a repositories object so every method call is timed under the `db`
 * prefix and labelled `group.method`, which is what lets the aggregate
 * `dbMs`/`dbMaxCallMs` totals be attributed to a particular query. Applied
 * per unit of work rather than at the composition root, because both service
 * containers are process-wide singletons and a shared wrapper could not
 * attribute a query to the request that caused it.
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
          // Both halves of the label are property keys from the repositories
          // object -- a closed set of static identifiers. No argument reaches
          // it, so nothing a caller supplies can travel into a log record.
          const label =
            typeof property === "string" && typeof method === "string"
              ? `${property}.${method}`
              : undefined;
          return (...args: unknown[]) =>
            scope.time(
              "db",
              async () =>
                (value as (...inner: unknown[]) => unknown).apply(
                  groupTarget,
                  args
                ),
              label
            );
        }
      });

      wrapped.set(property, measuredGroup);
      return measuredGroup;
    }
  }) as T;
}
