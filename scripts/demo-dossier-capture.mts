import { applicantDossierSchema } from "@slashwho/contracts";
import { dirname } from "node:path";

import { compactDossierWipes } from "../apps/web/src/lib/dossier-wipes.ts";

const emailAddress = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

export function redactDemoUploaderEmails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDemoUploaderEmails);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      key === "uploader" &&
      typeof nested === "string" &&
      emailAddress.test(nested.trim())
        ? null
        : redactDemoUploaderEmails(nested)
    ])
  );
}

export async function captureDemoDossier(
  source: URL,
  output: string,
  dependencies: Readonly<{
    fetch: typeof fetch;
    mkdir: typeof import("node:fs/promises").mkdir;
    writeFile: typeof import("node:fs/promises").writeFile;
  }>
) {
  const response = await dependencies.fetch(source, { cache: "no-store" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`demo_dossier_request_failed_${response.status}`);
  }

  const parsed = applicantDossierSchema.safeParse(
    redactDemoUploaderEmails(body)
  );
  if (!parsed.success) {
    throw new Error("demo_dossier_response_unexpected");
  }

  // Fold wiped pulls as the live dossier route does, and write it minified:
  // `/demo` serialises the whole capture into every page load.
  const dossier = compactDossierWipes(parsed.data);
  await dependencies.mkdir(dirname(output), { recursive: true });
  await dependencies.writeFile(output, `${JSON.stringify(dossier)}\n`, "utf8");

  return dossier;
}
