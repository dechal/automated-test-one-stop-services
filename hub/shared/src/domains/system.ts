/** Docker + compose-service status (GET /api/docker/status). */
export interface DockerStatus {
  dockerRunning: boolean;
  services: Record<string, string>;
}

/**
 * Host-Appium status (GET /api/appium/status). The server merges the live
 * process status with an `installed` probe, so this is the API DTO — distinct
 * from the server service's internal status shape (which carries process logs).
 */
export interface AppiumStatus {
  running: boolean;
  pid: number | null;
  port: number;
  installed: boolean;
}

/** Presence of a third-party tool's credentials.json (GET /api/credentials). */
export interface CredentialStatus {
  readonly tool: string;
  /** True once a `credentials.json` exists in the tool's credentials folder. */
  readonly hasCredentials: boolean;
}

/**
 * Google Sheet usage-logging readiness + on/off state (GET
 * /api/usage-logging/status). Readiness is DERIVED (credentials uploaded +
 * SPREADSHEET_ID set) — the user never edits config by hand.
 */
export interface UsageLoggingStatus {
  readonly hasCredentials: boolean;
  readonly hasSpreadsheetId: boolean;
  /** A Google token.json exists — the account has been connected at least once. */
  readonly hasToken: boolean;
  readonly forceTrack: boolean;
  readonly ready: boolean;
  readonly sheetName: string;
}

/** One project's local-vs-remote git status (GET /api/git/status). */
export interface GitStatusItem {
  project: string;
  tool: string;
  type: string;
  branch: string;
  localHash: string;
  remoteHash: string;
  hasUpdate: boolean;
  error?: string;
}

/** Outcome of pulling one project (POST /api/git/pull, /api/projects/pull-all). */
export interface PullResult {
  project: string;
  tool: string;
  type: string;
  success: boolean;
  output: string;
}
