// Minimal typings for the node modules contract.test.ts uses (the app tsconfig has no @types/node).
declare module 'node:child_process' {
  export interface ChildProcess {
    stdin: { on(ev: "error", cb: (e: Error) => void): unknown; write(c: Uint8Array, cb?: (e?: Error | null) => void): boolean; end(): void };
    stdout: { on(ev: 'data', cb: (c: Uint8Array) => void): unknown; on(ev: 'end' | 'close', cb: () => void): unknown };
    stderr: { on(ev: 'data', cb: (c: Uint8Array) => void): unknown };
    on(ev: 'exit' | 'close', cb: (code: number | null) => void): unknown;
    kill(sig?: string): boolean;
    killed: boolean;
  }
  export function spawn(cmd: string, args: string[], opts?: { stdio?: string[]; env?: Record<string, string | undefined> }): ChildProcess;
}
declare module 'node:fs' {
  export function existsSync(p: string): boolean;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(p: string, o?: { recursive?: boolean; force?: boolean }): void;
  export function readFileSync(p: string): Uint8Array;
  export function writeFileSync(p: string, d: string | Uint8Array): void;
  export function mkdirSync(p: string, o?: { recursive?: boolean }): void;
  export function readdirSync(p: string): string[];
  export function statSync(p: string): { size: number };
}
declare module 'node:os' {
  export function tmpdir(): string;
}
declare module 'node:path' {
  export function join(...p: string[]): string;
  export function resolve(...p: string[]): string;
}
declare module 'node:url' {
  export function fileURLToPath(u: string | URL): string;
}
