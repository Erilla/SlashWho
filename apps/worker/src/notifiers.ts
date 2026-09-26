import type {
  DiscoveryLogger,
  DiscoveryRunNotifier,
  EvidenceRunNotifier,
  FingerprintAlertNotifier
} from "@slashwho/application";

import type { NewApplicant } from "./applicant-watcher";
import type { WorkerConfig } from "./config";
import { postWebhook } from "./webhook";

export type NotifierOptions = {
  logger?: DiscoveryLogger;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/**
 * Announces each discovery run to a chat webhook. Discord rejects any body
 * without `content`, `embeds` or `file`, so the run is rendered as a message
 * rather than posted as the raw record. Delivery is best effort: the channel is
 * a convenience for whoever is watching, never a dependency of the run.
 */
export function createDiscoveryRunNotifier(
  config: WorkerConfig,
  options: NotifierOptions = {}
): DiscoveryRunNotifier {
  return {
    async started(run) {
      if (!config.discoveryWebhookUrl) return;
      const content = `🔍 Discovery run started — **${run.name}** (${run.region}/${run.realm}) · attempt ${run.attempt} · run \`${run.runId}\``;
      await postWebhook(
        config.discoveryWebhookUrl,
        { content },
        {
          ...options,
          failureRecord: { event: "discovery_announcement_delivery_failed" }
        }
      );
    }
  };
}

/**
 * Announces each evidence run to the same chat webhook as discovery, at its
 * start and again on its outcome. Evidence runs spend the Warcraft Logs
 * allowance, so `limitationCode`, `parseLimitationCode` and the points spent
 * are what the message exists to carry.
 *
 * Delivery is best effort throughout, exactly as it is for a discovery run:
 * the channel is a convenience for whoever is watching, never a dependency of
 * the run.
 */
export function createEvidenceRunNotifier(
  config: WorkerConfig,
  options: NotifierOptions = {}
): EvidenceRunNotifier {
  async function post(content: string): Promise<void> {
    if (!config.discoveryWebhookUrl) return;
    await postWebhook(
      config.discoveryWebhookUrl,
      { content },
      {
        ...options,
        failureRecord: { event: "evidence_announcement_delivery_failed" }
      }
    );
  }

  return {
    async started(run) {
      await post(
        `🧾 Evidence run started — **${run.name}** (${run.region}/${run.realm}) · attempt ${run.attempt} · run \`${run.runId}\``
      );
    },
    async finished(run) {
      // Only what is actually known: a run with no limitation and no readable
      // allowance announces its outcome and nothing more.
      const limitations = [run.limitationCode, run.parseLimitationCode].filter(
        (code): code is string => Boolean(code)
      );
      const details = [
        ...(limitations.length > 0 ? [limitations.join(" / ")] : []),
        ...(run.pointsSpent === null ? [] : [`${run.pointsSpent} points`])
      ];
      const icon = run.outcome === "complete" ? "✅" : "⚠️";
      await post(
        [
          `${icon} Evidence run ${run.outcome} — **${run.name}** (${run.region}/${run.realm})`,
          ...details,
          `run \`${run.runId}\``
        ].join(" · ")
      );
    }
  };
}

export function createFingerprintAlertNotifier(
  config: WorkerConfig,
  options: NotifierOptions = {}
): FingerprintAlertNotifier {
  const escapeDiscord = (value: string | undefined) =>
    (value?.slice(0, 200) || "—")
      .replace(/\s+/g, " ")
      .replace(/@/g, "@ ")
      .replace(/</g, "< ")
      .replace(/([\\*_`~|>()])/g, "\\$1")
      .replaceAll("[", "\\[")
      .replaceAll("]", "\\]");
  return {
    async notify(alert) {
      if (!config.maintainerAlertWebhookUrl) return;
      const discordWebhook =
        config.maintainerAlertWebhookUrl.startsWith(
          "https://discord.com/api/webhooks/"
        ) ||
        config.maintainerAlertWebhookUrl.startsWith(
          "https://discordapp.com/api/webhooks/"
        );
      const applicant = alert.applicant;
      const details = Object.entries(alert.details)
        .map(([name, count]) => `${name}: ${count}`)
        .join(" · ");
      const content = applicant
        ? [
            `📨 New application — ${details}`,
            `Battletag: ${escapeDiscord(applicant.battletag)}`,
            `Discord ID: ${escapeDiscord(applicant.discordId)}`,
            `Character: ${escapeDiscord(applicant.characterName)}`,
            `Character link: ${applicant.characterUrl}`,
            `Dossier: ${applicant.dossierUrl ?? "pending character resolution"}`
          ].join("\n")
        : `${alert.event === "applicant_new_intents" ? "📨" : "⚠️"} ${alert.event} — ${details}`;
      const body = discordWebhook
        ? {
            content,
            allowed_mentions: { parse: [] }
          }
        : alert;
      await postWebhook(config.maintainerAlertWebhookUrl, body, {
        ...options,
        failureRecord: {
          event: "maintainer_alert_delivery_failed",
          alertEvent: alert.event
        }
      });
    }
  };
}

/** An alert is a best-effort side effect of a committed Sheet observation. */
export async function announceNewApplicantIntents(
  poll: {
    baseline: boolean;
    created: number;
    newApplicants?: NewApplicant[];
  },
  notifier?: FingerprintAlertNotifier,
  logger?: DiscoveryLogger,
  dossierBaseUrl?: string
): Promise<void> {
  if (poll.baseline || poll.created === 0) return;
  if (!poll.newApplicants?.length) {
    try {
      await notifier?.notify({
        event: "applicant_new_intents",
        details: { count: poll.created }
      });
    } catch {
      logger?.info({ event: "applicant_announcement_failed" });
    }
    return;
  }
  for (const applicant of poll.newApplicants) {
    try {
      const { dossierPath, ...details } = applicant;
      await notifier?.notify({
        event: "applicant_new_intents",
        details: { count: 1 },
        applicant: {
          ...details,
          ...(dossierPath && dossierBaseUrl
            ? { dossierUrl: new URL(dossierPath, dossierBaseUrl).toString() }
            : {})
        }
      });
    } catch {
      logger?.info({ event: "applicant_announcement_failed" });
    }
  }
}
