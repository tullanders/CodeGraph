declare const vi: { mock(specifier: string): void };

vi.mock("some-external-package");

export const helper = (value: string) => value.trim();

export function useHelper() {
  return helper("hello");
}
