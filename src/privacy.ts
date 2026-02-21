export function maskSensitiveText(input: string): string {
  let masked = input;

  const patterns: RegExp[] = [
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key pattern
    /\bsk-[A-Za-z0-9]{20,}\b/g, // common API token pattern
    /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub personal access token pattern
    /\bAIza[0-9A-Za-z\-_]{35}\b/g, // Google API key pattern
    /\b(?:xox[pbar]-[A-Za-z0-9-]{10,})\b/g, // Slack token pattern
    /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
    /\b(?:password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"']+["']/gi
  ];

  for (const pattern of patterns) {
    masked = masked.replace(pattern, "[REDACTED]");
  }
  return masked;
}
