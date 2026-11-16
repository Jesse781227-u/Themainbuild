// Structured JSON logs (Workers Logs and Node both capture console output). Never pass tokens or
// full phone numbers: use maskPhone() from lib/phone.
type Level = 'info' | 'warn' | 'error';
export function log(level: Level, message: string, meta: Record<string, unknown> = {}) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, service: 'relay-api', message, ...meta });
  if (level === 'error') console.error(line); else if (level === 'warn') console.warn(line); else console.log(line);
}
