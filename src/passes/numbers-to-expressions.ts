// NumbersToExpressions: replaces every NumericLiteral with an IIFE that
// rebuilds the same value at runtime through a random chain of add/subtract
// steps, e.g. `3` becomes:
//   (function() local _x = 38831 _x = _x - 30011 _x = _x - 15817 return _x end)()
// The number of steps is randomized between `min` and `max` (inclusive).
import * as N from '../ast/nodes';
import { transformExpressions } from '../utils/walk';
import { ident, numLit, binExpr, localStmt, assignStmt, returnStmt, funcExpr, callExpr, paren } from '../ast/builders';
import { randInt, randomVarName } from '../utils/random';
import { Pass } from './types';

function buildNumberExpr(value: number, min: number, max: number): N.Expression {
  const steps = randInt(min, max);
  const deltas: number[] = [];
  for (let i = 0; i < steps; i++) {
    // Keep deltas an order of magnitude away from zero so the intermediate
    // value doesn't just happen to look like the original.
    const magnitude = randInt(1000, 60000);
    deltas.push(randInt(0, 1) === 0 ? magnitude : -magnitude);
  }
  const sum = deltas.reduce((a, b) => a + b, 0);
  const initial = value + sum;

  const scope = new Set<string>();
  const varName = randomVarName(scope);
  const v = ident(varName);

  // synthetic: true — these rebuild the target value, they aren't literals
  // from the source. EncryptNumbers/ConstantArray must not re-obfuscate them.
  const stmts: N.Statement[] = [localStmt([ident(varName)], [numLit(initial, true)])];
  for (const d of deltas) {
    const op = d >= 0 ? '-' : '+';
    stmts.push(assignStmt([ident(varName)], [binExpr(op, v, numLit(Math.abs(d), true))]));
  }
  stmts.push(returnStmt([v]));

  const fn = funcExpr([], stmts);
  return callExpr(paren(fn), []);
}

export const numbersToExpressions: Pass<{ min?: number; max?: number }> = (chunk, _ctx, opts) => {
  const min = opts?.min ?? 3;
  const max = Math.max(min, opts?.max ?? 8);
  transformExpressions(chunk, (expr) => {
    // Skip literals already synthesized by an earlier pass (e.g. character
    // codes from StringsToExpressions, or index arithmetic from
    // ConstantArray) — otherwise a single long string or a pass reorder
    // turns into thousands of rebuilt-at-runtime numbers.
    if (expr.type === 'NumericLiteral' && Number.isFinite(expr.value) && !expr.synthetic) {
      return buildNumberExpr(expr.value, min, max);
    }
    return null;
  });
  return chunk;
};
