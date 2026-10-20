/** Sanitize before truncation so cutting a URL cannot expose part of its credentials. */
export function sanitizeGitError(text: string): string {
  const safe = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '[redacted URL]')
    .replace(/\b(?:authorization|proxy-authorization)\s*:[^\n]*/gi, '[redacted authorization]')
    .replace(/\b(password|passwd|token|access_token|secret|api_key)\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s<>]+)/gi, '$1=[redacted]')
    .trim();
  return safe.length > 6000 ? `${safe.slice(0, 2000)}\n[…]\n${safe.slice(-4000)}` : safe;
}
