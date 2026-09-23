import { createHmac } from "node:crypto";
import { isIP } from "node:net";

/** The canonical mailbox key shared by registration, sign-in, and recovery. */
export function canonicalizeEmail(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length > 254) return null;
  const canonical = trimmed.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (
    !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      canonical
    )
  ) {
    return null;
  }
  return canonical;
}

/** Opaque registration bucket keys; never trust forwarding headers from callers. */
export function registrationSubjects(
  request: Request,
  canonicalEmail: string,
  hashSecret: string
): { ipSubjectHash: string | null; emailSubjectHash: string } {
  const ip = request.headers.get("x-real-ip")?.trim();
  const trustedIp = ip && isIP(ip) !== 0 ? ip : null;
  const digest = (subject: string) =>
    createHmac("sha256", hashSecret).update(subject).digest("hex");
  return {
    ipSubjectHash: trustedIp ? digest(`registration-ip\0${trustedIp}`) : null,
    emailSubjectHash: digest(`registration-email\0${canonicalEmail}`)
  };
}
