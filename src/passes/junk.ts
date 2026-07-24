import * as N from '../ast/nodes';
import { Pass, PassContext } from './types';
import { randomVarName, randInt, choice } from '../utils/random';
import { ident, localStmt, assignStmt, callExpr, funcExpr } from '../ast/builders';

const dummyLoc = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
const dummyRange: [number, number] = [0, 0];

const numLiteral = (value: number): N.NumericLiteral => ({
  type: 'NumericLiteral',
  value,
  raw: value.toString(),
  range: dummyRange,
  loc: dummyLoc
});

const JUNK_TEMPLATES = [
  // 1. 의미 없는 local
  (): N.Statement => {
    const name = randomVarName(new Set());
    return localStmt([ident(name)], [numLiteral(randInt(100, 99999))]);
  },

  // 2. 의미 없는 연산
  (): N.Statement => {
    const name = randomVarName(new Set());
    return assignStmt([ident(name)], [{
      type: 'BinaryExpression',
      operator: choice(['+', '-', '*', '//', '%', '^'] as const),
      left: numLiteral(randInt(10, 500)),
      right: numLiteral(randInt(10, 500)),
      range: dummyRange,
      loc: dummyLoc
    }]);
  },

  // 3. 항상 false인 if
  (): N.Statement => {
    const dummyName = randomVarName(new Set());
    return {
      type: 'IfStatement',
      clauses: [{
        type: 'IfClause',
        condition: {
          type: 'BinaryExpression',
          operator: '>',
          left: numLiteral(randInt(100, 400)),
          right: numLiteral(randInt(500, 999)),
          range: dummyRange,
          loc: dummyLoc
        },
        body: [localStmt([ident(dummyName)], [{ type: 'NilLiteral', range: dummyRange, loc: dummyLoc }])],
        range: dummyRange,
        loc: dummyLoc
      }],
      range: dummyRange,
      loc: dummyLoc
    } as N.IfStatement;
  },

  // 4. pcall junk
  (): N.Statement => ({
    type: 'CallStatement',
    expression: callExpr(ident('pcall'), [funcExpr([], [])]),
    range: dummyRange,
    loc: dummyLoc
  } as N.CallStatement),
];

export const insertJunk: Pass<{ probability?: number; maxPerBlock?: number }> = (chunk, ctx, options) => {
  const probability = options.probability ?? 0.33;
  const maxPerBlock = options.maxPerBlock ?? 30;
  let junkCount = 0;
  
  const visit = (stmts: N.Statement[]): N.Statement[] => {
    const result: N.Statement[] = [];

    for (const stmt of stmts) {
      if (junkCount < maxPerBlock && Math.random() < probability) {
        result.push(choice(JUNK_TEMPLATES)());
        junkCount++;
      }

      result.push(stmt);

      // body 내부 재귀 처리
      if ('body' in stmt && Array.isArray((stmt as any).body)) {
        (stmt as any).body = visit((stmt as any).body);
      }

      // IfStatement 처리
      if (stmt.type === 'IfStatement') {
        const ifStmt = stmt as N.IfStatement;
        for (const clause of ifStmt.clauses) {
          if ('body' in clause && Array.isArray((clause as any).body)) {
            (clause as any).body = visit((clause as any).body);
          }
        }
      }
    }

    return result;
  };

  chunk.body = visit(chunk.body);
  return chunk;
};