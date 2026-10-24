// One list per vocabulary: the types and the runtime check cannot drift apart.
const events = ['server_started', 'server_stopped', 'request_failed', 'source_failed'] as const;
const metricKeys = ['count', 'durationMs'] as const;
type LogEvent = typeof events[number];
type Metrics = Partial<Record<typeof metricKeys[number], number>>;

function isValid(event: string, metrics: Record<string, unknown>): boolean {
  return (events as readonly string[]).includes(event) && Object.entries(metrics).every(([key, value]) =>
    (metricKeys as readonly string[]).includes(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

export function createLogger(write: (line: string) => void = line => process.stderr.write(line)) {
  return (event: LogEvent, metrics: Metrics = {}) => {
    if (!isValid(event, metrics)) throw new Error('Invalid log entry.');
    write(`${JSON.stringify({ event, ...metrics })}\n`);
  };
}
