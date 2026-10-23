import type { MeasurementScope } from "./measurement";

/**
 * The argument position of each evidence read's request-bound read-step
 * observer. Positions are explicit because `reserveForScheduling` already uses
 * its second argument for the scheduling callback; inferring "the last
 * optional argument" would silently skip it.
 */
const rosterReadObserverIndex = new Map<string, number>([
  ["getCompleted", 1],
  ["hydrateCompletedEvidence", 1],
  ["reserve", 1],
  ["reserveForScheduling", 2]
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
                const observerIndex =
                  property === "evidence"
                    ? rosterReadObserverIndex.get(String(method))
                    : undefined;
                if (
                  observerIndex !== undefined &&
                  args[observerIndex] === undefined
                ) {
                  // The observer is supplied at the method's declared
                  // position, never by counting the arguments it was given.
                  while (args.length < observerIndex) args.push(undefined);
                  args[observerIndex] = <R>(
                    step: "evidence.raiderIoRoster",
                    work: () => Promise<R>
                  ) =>
                    exclude(() =>
                      // Two prefixes, one execution. `db` keeps the step in
                      // dbCalls/dbMs/dbMaxCallName; `dbRoster` is a dedicated
                      // family so the roster remains reportable when a larger
                      // call, such as the scheduling reserve, owns
                      // dbMaxCallName. The enclosing repository call excludes
                      // the outer frame, so dbMs still charges the work once.
                      scope.time(
                        "db",
                        () => scope.time("dbRoster", work, step),
                        step
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
