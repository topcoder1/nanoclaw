export function isSignerAutoSignEnabled(): boolean {
  return process.env.SIGNER_AUTO_SIGN_ENABLED === 'true';
}
