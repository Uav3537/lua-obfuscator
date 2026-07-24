// StringsToExpressions: replaces every StringLiteral with a runtime-built
// concatenation expression. The string is split into `steps` (min..max)
// chunks; each chunk is emitted either as a plain substring literal or as a
// string.char(...) call over its byte codes, then joined with `..`.
import * as N from '../ast/nodes';
import { transformExpressions } from '../utils/walk';
import { strLit, numLit, binExpr, callExpr, ident, memberExpr } from '../ast/builders';
import { randInt } from '../utils/random';
import { Pass } from './types';

function stringCharCall(chunkStr: string): N.Expression {
  const codes = Array.from(chunkStr).map((c) => numLit(c.codePointAt(0)!));
  return callExpr(memberExpr(ident('string'), 'char'), codes);
}

function splitInto(s: string, parts: number): string[] {
  if (parts <= 1 || s.length === 0) return [s];
  parts = Math.min(parts, s.length);
  const chars = Array.from(s);
  const base = Math.floor(chars.length / parts);
  const remainder = chars.length % parts;
  const out: string[] = [];
  let idx = 0;
  for (let i = 0; i < parts; i++) {
    const len = base + (i < remainder ? 1 : 0);
    out.push(chars.slice(idx, idx + len).join(''));
    idx += len;
  }
  return out.filter((p) => p.length > 0);
}

function buildStringExpr(value: string, min: number, max: number): N.Expression {
  if (value.length === 0) return strLit('');
  const steps = Math.max(1, Math.min(randInt(min, max), value.length));
  const pieces = splitInto(value, steps);

  let result: N.Expression | null = null;
  for (const piece of pieces) {
    const pieceExpr: N.Expression = randInt(0, 1) === 0 ? strLit(piece) : stringCharCall(piece);
    result = result === null ? pieceExpr : binExpr('..', result, pieceExpr);
  }
  return result!;
}

export const stringsToExpressions: Pass<{ min?: number; max?: number }> = (chunk, _ctx, opts) => {
  const min = opts?.min ?? 3;
  const max = Math.max(min, opts?.max ?? 8);
  transformExpressions(chunk, (expr) => {
    if (expr.type === 'StringLiteral') {
      return buildStringExpr(expr.value, min, max);
    }
    return null;
  });
  return chunk;
};
