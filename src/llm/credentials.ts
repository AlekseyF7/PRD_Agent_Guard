import type { ApiKeySource } from './types.js';

// Only this adapter reads environment variables. The client accepts any trusted
// implementation of ApiKeySource, including the future OS credential store.
export function environmentKeySource(environment: NodeJS.ProcessEnv = process.env): ApiKeySource {
  return (reference) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) throw new Error('Invalid environment reference');
    return environment[reference];
  };
}
