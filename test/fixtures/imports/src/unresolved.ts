declare const vi: { mock(specifier: string): void };

vi.mock("some-external-package");

export const helper = (value: string) => value.trim();

export function useHelper() {
  return helper("hello");
}

export function useExternal(value: string) {
  return JSON.stringify(value);
}

export function useUnknown(target: any) {
  return target.whatever();
}
