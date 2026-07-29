// Small helpers for synthesizing AST nodes in obfuscation passes. Passes
// don't care about accurate source positions, so every builder stamps a
// dummy (0,0)-(0,0) location — codegen never reads range/loc.
import * as N from './nodes';

const DUMMY_LOC: N.SourceLocation = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
const DUMMY_RANGE: [number, number] = [0, 0];

function base() {
  return { range: DUMMY_RANGE, loc: DUMMY_LOC };
}

// Synthesized identifiers have no real scope to resolve against (they're
// never passed through resolveScopes()), so they're stamped 'global' /
// bindingId: null as an inert default — codegen only ever reads `.name`.
export function ident(name: string): N.Identifier {
  return { type: 'Identifier', name, attribute: null, typeAnnotation: null, scope: 'global', isField: false, bindingId: null, ...base() };
}

/** The `...` node — used both as a function parameter (vararg declaration) and as an expression. */
export function varargParam(): N.VarargLiteral {
  return { type: 'VarargLiteral', value: '...', ...base() };
}

export function numLit(value: number, synthetic = false): N.NumericLiteral {
  return { type: 'NumericLiteral', value, raw: String(value), synthetic, ...base() };
}

export function strLit(value: string, synthetic = false): N.StringLiteral {
  return { type: 'StringLiteral', value, raw: JSON.stringify(value), synthetic, ...base() };
}

export function boolLit(value: boolean): N.BooleanLiteral {
  return { type: 'BooleanLiteral', value, ...base() };
}

export function nilLit(): N.NilLiteral {
  return { type: 'NilLiteral', ...base() };
}

export function binExpr(operator: N.BinaryOperator, left: N.Expression, right: N.Expression): N.BinaryExpression {
  return { type: 'BinaryExpression', operator, left, right, ...base() };
}

export function unaryExpr(operator: N.UnaryExpression['operator'], argument: N.Expression): N.UnaryExpression {
  return { type: 'UnaryExpression', operator, argument, ...base() };
}

export function paren(expression: N.Expression): N.ParenthesizedExpression {
  return { type: 'ParenthesizedExpression', expression, ...base() };
}

export function callExpr(calleeBase: N.Expression, args: N.Expression[]): N.CallExpression {
  return { type: 'CallExpression', base: calleeBase, arguments: args, ...base() };
}

export function memberExpr(objBase: N.Expression, name: string): N.MemberExpression {
  // .identifier is a field name (`.foo`), never a variable reference — it
  // must carry isField: true or passes that key off isField (GlobalMapping,
  // resolveScopes) will mistake it for a real global/local binding and
  // rewrite or resolve it incorrectly.
  return { type: 'MemberExpression', indexer: '.', base: objBase, identifier: { ...ident(name), isField: true }, optional: false, ...base() };
}

export function indexExpr(objBase: N.Expression, index: N.Expression): N.IndexExpression {
  return { type: 'IndexExpression', base: objBase, index, optional: false, ...base() };
}

export function tableCtor(fields: N.TableField[]): N.TableConstructorExpression {
  return { type: 'TableConstructorExpression', fields, ...base() };
}

export function tableValue(value: N.Expression): N.TableValue {
  return { type: 'TableValue', value, ...base() };
}

export function localStmt(variables: N.Identifier[], init: N.Expression[]): N.LocalStatement {
  return { type: 'LocalStatement', variables, init, ...base() };
}

export function assignStmt(variables: N.AssignmentTarget[], init: N.Expression[]): N.AssignmentStatement {
  return { type: 'AssignmentStatement', variables, init, ...base() };
}

export function callStmt(expression: N.CallExpression): N.CallStatement {
  return { type: 'CallStatement', expression, ...base() };
}

export function returnStmt(args: N.Expression[]): N.ReturnStatement {
  return { type: 'ReturnStatement', arguments: args, ...base() };
}

export function funcExpr(
  parameters: N.FunctionParameter[],
  body: N.Statement[],
  hasVararg = false
): N.FunctionDeclaration {
  return {
    type: 'FunctionDeclaration',
    identifier: null,
    isLocal: false,
    isMethod: false,
    parameters,
    body,
    hasVararg,
    varargTypeAnnotation: null,
    generics: [],
    returnTypeAnnotation: null,
    ...base(),
  };
}

export function whileStmt(condition: N.Expression, body: N.Statement[]): N.WhileStatement {
  return { type: 'WhileStatement', condition, body, ...base() };
}

export function chunk(body: N.Statement[]): N.Chunk {
  return { type: 'Chunk', body, ...base() };
}
