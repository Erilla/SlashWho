import type { MeasurementScope } from "./measurement";

/**
 * Evidence reads that hydrate a completed publication, and so may load the
 * Raider.IO roster. They accept a request-bound read-step observer as their
 * last argument.
 */
const rosterReadMethods = new Set([
  "getCompleted",
  "hydrateCompletedEvidence",
  "reserve"
]);

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
      const group: unknown = Reflect.get(target, property, receiver);
      if (typeof group !== "object" || group === null) return group;
      if (wrapped.has(property)) return wrapped.get(property);

      const measuredGroup = new Proxy(group, {
        get(groupTarget, method, groupReceiver) {
          const value: unknown = Reflect.get(
            groupTarget,
            method,
            groupReceiver
          );
          if (typeof value !== "function") return value;
          // Both halves of the label are property keys from the repositories
          // object -- a closed set of static identifiers. No argument reaches
          // it, so nothing a caller supplies can travel into a log record.
          const label =
            typeof property === "string" && typeof method === "string"
              ? `${property}.${method}`
              : undefined;
          const call = value as (...inner: unknown[]) => unknown;
          return (...args: unknown[]) =>
            scope.time(
              "db",
              async (exclude) => {
                if (
                  property === "evidence" &&
                  rosterReadMethods.has(String(method)) &&
                  // The observer is the only optional argument after the
                  // repository's input, so a caller-supplied one already
                  // occupies the slot the wrapper would fill.
                  args[1] === undefined
                ) {
                  // The roster is a named read inside the enclosing call.
                  // Exclude it from the parent's duration so dbMs charges it
                  // once, but let it count as its own call: dbCalls gains one
                  // per hydration that actually reads a roster, so it
                  // measures timed read steps rather than only repository
                  // calls (it was never a SQL statement count). The step can
                  // win dbMaxCallName, which is how the baseline names the
                  // roster queries. The label is static, as every logging
                  // label must be.
                  args.push(
                    <R>(
                      step: "evidence.raiderIoRoster",
                      work: () => Promise<R>
                    ) =>
                      exclude(() =>
                        scope.time("db", async () => await work(), step)
                      )
                  );
                }
                return await call.apply(groupTarget, args);
              },
              label
            );
        }
      });

      wrapped.set(property, measuredGroup);
      return measuredGroup;
    }
  });
}
