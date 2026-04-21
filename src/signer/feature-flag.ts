import { readEnvValue } from '../env.js';

export function isSignerAutoSignEnabled(): boolean {
  return readEnvValue('SIGNER_AUTO_SIGN_ENABLED') === 'true';
}
