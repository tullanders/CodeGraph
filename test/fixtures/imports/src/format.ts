export interface Formatter {
  formatMessage(value: string): string;
}

export function formatMessage(value: string) {
  return `Application ${value}`;
}