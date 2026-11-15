/**
 * Compile-time assertions for type tests: `type _ = Expect<Equal<A, B>>`
 * fails `tsc` unless A and B are the same type.
 */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

export type Expect<T extends true> = T;
