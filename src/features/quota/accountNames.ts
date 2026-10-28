/**
 * Short names for credential files: "claude-e36c4ea2-team@stofloos.nl.json" reads as
 * "team". Names that do not follow the provider-hash-email pattern stay as they are.
 */
export function shortAccountName(file: string): string {
  const match = /^[a-z]+-[0-9a-f]{6,}-([^@]+)@/i.exec(file);
  return match ? match[1] : file.replace(/\.json$/i, '');
}

/** Provider prefix of a credential file name, such as "claude" or "codex". */
export function accountProvider(file: string): string {
  return /^([a-z]+)-/i.exec(file)?.[1]?.toLowerCase() ?? '';
}
