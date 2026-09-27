import { MYTHIC_DIFFICULTY, reportActorsQuery } from "../queries";
import {
  characterVariables,
  recentReportsQuery,
  type CharacterLookup
} from "../queries";
import { nonEmptyString, positiveInteger, record } from "../decode/primitives";
import { recentReportsData } from "../decode/reports";
import type { GraphqlResult } from "../transport";
import { unavailableOnTimeout, type CollectionRun } from "./context";

/**
 * Whether a report holds a fight that could become evidence: a boss fight on
 * Mythic. The decoder turns nothing else into a kill or a wipe, so the actors
 * that attribute a fight to the character are wanted for these reports alone.
 */
function holdsMythicEncounter(reportValue: unknown): boolean {
  const fights = record(reportValue)?.fights;
  return (
    Array.isArray(fights) &&
    fights.some((fightValue) => {
      const fight = record(fightValue);
      return (
        fight !== null &&
        positiveInteger(fight.encounterID) !== null &&
        fight.difficulty === MYTHIC_DIFFICULTY
      );
    })
  );
}

/**
 * One page of the character's report history, in the shape the history
 * decoder reads: every report carrying its fights and its player actors.
 *
 * Warcraft Logs charges about a point per report for `fights` and another for
 * `masterData`, and about two reports in three hold no Mythic encounter fight
 * at all. So the page is read without actors, and the actors of the reports
 * that can hold evidence follow in one aliased request (#712). A report with
 * no Mythic encounter fight is given an empty actor list: the decoder skips
 * each of its fights on difficulty before it looks at who took part, so the
 * evidence it yields is the same.
 *
 * The follow-up is part of reading the page, not a page of its own, so it
 * spends nothing of the history cap: counting it there would halve how deep a
 * capped scan reaches. A follow-up that fails fails the page, and a report it
 * does not answer for is left without actors, which the decoder rejects as
 * drift rather than reading as a report the character was absent from.
 */
export async function readHistoryPage(
  run: CollectionRun,
  lookup: CharacterLookup,
  page: number,
  catchTimeout: boolean
): Promise<GraphqlResult> {
  const { options } = run;
  const guard = <T>(request: Promise<T>) =>
    catchTimeout
      ? request.catch(unavailableOnTimeout(options.signal))
      : request;
  const result = await run.counted("history_scan", () =>
    guard(
      run.ctx.graphql(
        recentReportsQuery(lookup),
        { ...characterVariables(lookup), page },
        options.signal
      )
    )
  );
  if (result.kind !== "success") return result;
  const reports = recentReportsData(result.value);
  const wanted = [
    ...new Set(
      reports.flatMap((reportValue) => {
        const code = nonEmptyString(record(reportValue)?.code);
        return code && holdsMythicEncounter(reportValue) ? [code] : [];
      })
    )
  ];
  const actorsByCode = new Map<string, unknown>();
  if (wanted.length > 0) {
    const actors = await run.counted("history_actors", () =>
      guard(
        run.ctx.graphql(
          reportActorsQuery(wanted.length),
          Object.fromEntries(
            wanted.map((code, index) => [`code${index}`, code])
          ),
          options.signal
        )
      )
    );
    if (actors.kind !== "success") return actors;
    const reportData = record(record(record(actors.value)?.data)?.reportData);
    for (const [index, code] of wanted.entries()) {
      const report = reportData && record(reportData[`report${index}`]);
      const masterData = report && record(report.masterData);
      if (
        report &&
        nonEmptyString(report.code) === code &&
        masterData &&
        Array.isArray(masterData.actors)
      ) {
        actorsByCode.set(code, masterData);
      }
    }
  }
  return { kind: "success", value: withActors(result.value, actorsByCode) };
}

function withActors(
  value: unknown,
  actorsByCode: ReadonlyMap<string, unknown>
): unknown {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const characterData = data && record(data.characterData);
  const character = characterData && record(characterData.character);
  const recentReports = character && record(character.recentReports);
  if (!envelope || !data || !characterData || !character || !recentReports) {
    return value;
  }
  const reports = recentReports.data;
  if (!Array.isArray(reports)) return value;
  return {
    ...envelope,
    data: {
      ...data,
      characterData: {
        ...characterData,
        character: {
          ...character,
          recentReports: {
            ...recentReports,
            data: reports.map((reportValue: unknown) => {
              const report = record(reportValue);
              if (!report) return reportValue;
              const code = nonEmptyString(report.code);
              if (!holdsMythicEncounter(report)) {
                return { ...report, masterData: { actors: [] } };
              }
              const masterData = code ? actorsByCode.get(code) : undefined;
              return masterData === undefined
                ? report
                : { ...report, masterData };
            })
          }
        }
      }
    }
  };
}
