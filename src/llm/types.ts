export interface LlmSettings {
  readonly baseURL: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly authMode: 'apiKey' | 'none';
  readonly credentialRef?: string;
}
export type ApiKeySource = (credentialRef: string) => string | undefined | Promise<string | undefined>;
export interface LlmDependencies {
  readonly resolveApiKey?: ApiKeySource;
  readonly fetch?: typeof globalThis.fetch;
}
export type LlmErrorCode =
  | 'INVALID_ACTION' | 'MISSING_API_KEY' | 'INVALID_API_KEY' | 'CREDENTIAL_ERROR'
  | 'TIMEOUT' | 'NETWORK_ERROR' | 'AUTH_ERROR' | 'RATE_LIMIT' | 'SERVER_ERROR'
  | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'REQUEST_TOO_LARGE' | 'RESPONSE_TOO_LARGE'
  | 'SENSITIVE_DATA';
