export function nowISO(): string {
  return new Date().toISOString();
}

export function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function toISO(date: Date): string {
  return date.toISOString();
}
