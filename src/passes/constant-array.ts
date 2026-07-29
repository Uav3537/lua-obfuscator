// ConstantArray: pools every remaining string/number literal into a single
// shuffled array declared at the top of the chunk, and rewrites each
// original literal site into an indexed lookup into that array
// (`_arr[7]`, ...). A small offset function scrambles the visible index so
// the raw table isn't trivially readable top-to-bottom either.
import * as N from '../ast/nodes';
import { transformExpressions } from '../utils/walk';
import { ident, indexExpr, numLit, tableCtor, tableValue, localStmt, binExpr, paren } from '../ast/builders';
import { randInt, randomVarName, shuffle } from '../utils/random';
import { Pass } from './types';

export const constantArray: Pass<Record<string, never>> = (chunk) => {
  const pool: N.Expression[] = [];
  // Dedupe by value: without this, every occurrence of a repeated string/
  // number gets its own array slot AND its own pair of index-arithmetic
  // NumericLiterals at the call site, which is wasted work and (if a
  // literal-expansion pass runs later) a multiplier on the blow-up.
  const slotByValue = new Map<string, number>();
  // originalSlot (by occurrence, in walk order) -> pooled slot, so the
  // second walk below can map each site back to its (possibly shared) slot.
  const slotByOccurrence: number[] = [];

  transformExpressions(chunk, (expr) => {
    if ((expr.type === 'StringLiteral' || expr.type === 'NumericLiteral') && !expr.synthetic) {
      const key = `${expr.type}:${expr.type === 'StringLiteral' ? expr.value : expr.value}`;
      let slot = slotByValue.get(key);
      if (slot === undefined) {
        slot = pool.length;
        pool.push(expr);
        slotByValue.set(key, slot);
      }
      slotByOccurrence.push(slot);
      return null; // rewritten in the second pass below, once slots are shuffled
    }
    return null;
  });

  if (pool.length === 0) return chunk;

  // Shuffle physical storage order but remember each literal's real slot.
  const order = shuffle(pool.map((_, i) => i));
  const physicalIndexOf = new Map<number, number>(); // original slot -> 1-based Lua index
  order.forEach((originalSlot, physicalPos) => {
    physicalIndexOf.set(originalSlot, physicalPos + 1);
  });

  const names = new Set<string>();
  const arrName = randomVarName(names);
  const offset = randInt(1, 50);

  const arrayFields = order.map((originalSlot) => tableValue(pool[originalSlot]));
  const decl = localStmt([ident(arrName)], [tableCtor(arrayFields)]);

  let occurrenceIndex = 0;
  transformExpressions(chunk, (expr) => {
    if ((expr.type === 'StringLiteral' || expr.type === 'NumericLiteral') && !expr.synthetic) {
      const originalSlot = slotByOccurrence[occurrenceIndex++];
      const physicalIndex = physicalIndexOf.get(originalSlot)!;
      // physicalIndex = shown_index + offset, so shown_index = physicalIndex - offset
      const shownIndex = physicalIndex - offset;
      // synthetic: true — index arithmetic, not a source literal. Skipped by
      // NumbersToExpressions/EncryptNumbers regardless of pipeline order.
      const indexExprNode =
        offset === 0
          ? numLit(physicalIndex, true)
          : binExpr('+', numLit(shownIndex, true), numLit(offset, true));
      return indexExpr(ident(arrName), paren(indexExprNode));
    }
    return expr;
  });

  chunk.body = [decl, ...chunk.body];
  return chunk;
};
