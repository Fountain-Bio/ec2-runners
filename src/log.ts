// Structured logging. Each line is one JSON object, which CloudWatch Logs
// Insights can query by field.

export function log(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ msg, ...fields }));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
