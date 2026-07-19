export interface Env {
  ASSETS: Fetcher;
  ARTIFACTS?: R2Bucket;
  PROCESSOR?: DurableObjectNamespace;
  PROCESSOR_URL?: string;
  /** Origin reachable from the processor (e.g. host.docker.internal in local Docker). */
  API_CALLBACK_ORIGIN?: string;
}
