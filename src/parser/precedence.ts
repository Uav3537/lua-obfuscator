// Precedence per the Lua 5.1 reference manual (low -> high); Luau is the same
// except it also adds `//`:
//
//   or
//   and
//   <     >     <=    >=    ~=    ==
//   ..                                  (right-associative)
//   +     -
//   *     /     //    %
//   not   #     -(unary)                (handled separately in parseUnary, parser.ts)
//   ^                                    (right-associative, binds tighter than unary)
//
// Higher numbers bind more tightly.

export const UNARY_PRECEDENCE = 8;

interface OpInfo {
  precedence: number;
  rightAssoc: boolean;
}

const TABLE: Record<string, OpInfo> = {
  or: { precedence: 1, rightAssoc: false },
  and: { precedence: 2, rightAssoc: false },

  '<': { precedence: 3, rightAssoc: false },
  '>': { precedence: 3, rightAssoc: false },
  '<=': { precedence: 3, rightAssoc: false },
  '>=': { precedence: 3, rightAssoc: false },
  '~=': { precedence: 3, rightAssoc: false },
  '==': { precedence: 3, rightAssoc: false },

  '..': { precedence: 4, rightAssoc: true },

  '+': { precedence: 5, rightAssoc: false },
  '-': { precedence: 5, rightAssoc: false },

  '*': { precedence: 6, rightAssoc: false },
  '/': { precedence: 6, rightAssoc: false },
  '//': { precedence: 6, rightAssoc: false }, // Luau-only; if lua5.1, the parser already rejects the token before this matters
  '%': { precedence: 6, rightAssoc: false },

  '^': { precedence: 9, rightAssoc: true }, // binds even tighter than unary (8): -x^2 === -(x^2)
};

export function getBinaryOpInfo(op: string): OpInfo | null {
  return TABLE[op] ?? null;
}

export function isLogicalOperator(op: string): op is 'and' | 'or' {
  return op === 'and' || op === 'or';
}
