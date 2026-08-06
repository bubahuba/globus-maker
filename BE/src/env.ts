export interface Env {
  ASSETS: Fetcher;
  ARTIFACTS?: R2Bucket;
  PROCESSOR_URL?: string;
  /** Origin reachable from the processor (e.g. host.docker.internal in local Docker). */
  API_CALLBACK_ORIGIN?: string;
  /**
   * Monitor site origin hosting PHP globe-preview archive APIs
   * (`/globe-preview/list.php`, `save.php`, static JPEGs). Default https://rgb.sk.
   */
  MONITOR_ORIGIN?: string;

  /** sandbox | live */
  PAYPAL_MODE?: string;
  /** Prefer these; USER_PAYPAL / PASS_PAYPAL are aliases. */
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  USER_PAYPAL?: string;
  PASS_PAYPAL?: string;
  PAYPAL_CURRENCY?: string;
}
