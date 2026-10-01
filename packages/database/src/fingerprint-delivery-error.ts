export class StaleFingerprintDeliveryError extends Error {
  constructor() {
    super("stale_fingerprint_delivery");
  }
}
