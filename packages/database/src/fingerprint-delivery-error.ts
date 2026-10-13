export class StaleFingerprintDeliveryError extends Error {
  override readonly name = "StaleFingerprintDeliveryError";
  constructor() {
    super("stale_fingerprint_delivery");
  }
}
