// `bun:sqlite` ships no @types under this package's tsconfig (`types` is scoped
// to workers-types + node). Declare the tiny surface the CLI uses so
// `tsc --noEmit` resolves the import; the Bun runtime provides the real module.
declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string)
    query(sql: string): {
      get(...params: unknown[]): unknown
      all(...params: unknown[]): unknown[]
      run(...params: unknown[]): unknown
    }
    close(): void
  }
}
