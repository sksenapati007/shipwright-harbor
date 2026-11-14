// Minimal typings for the node pieces the 6E tests use (the app tsconfig has no @types/node).
interface Buffer extends Uint8Array {}
declare const Buffer: {
  from(s: string | ArrayLike<number>): Buffer;
  alloc(n: number, fill?: number): Buffer;
};
declare module 'node:crypto' {
  export function createHash(a: 'sha256'): { update(d: Uint8Array): { digest(enc: 'hex'): string } };
  export const webcrypto: unknown;
}
