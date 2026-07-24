// Generic, mutating, bottom-up AST walker. Most obfuscation passes just want
// to replace certain Expression nodes wherever they appear (numeric/string
// literals -> expressions, etc.) without hand-rolling traversal over every
// statement kind — this file is the one place that knows the full node shape.
import * as N from '../ast/nodes';

export type ExprTransform = (expr: N.Expression) => N.Expression | null | void;

function tExpr(expr: N.Expression, fn: ExprTransform): N.Expression {
  // Recurse into children first (post-order), then transform this node.
  switch (expr.type) {
    case 'FunctionDeclaration':
      expr.body = tStmts(expr.body, fn);
      break;
    case 'TableConstructorExpression':
      for (const f of expr.fields) {
        if (f.type === 'TableKey') {
          f.key = tExpr(f.key, fn);
          f.value = tExpr(f.value, fn);
        } else if (f.type === 'TableKeyString') {
          f.value = tExpr(f.value, fn);
        } else {
          f.value = tExpr(f.value, fn);
        }
      }
      break;
    case 'BinaryExpression':
    case 'LogicalExpression':
      expr.left = tExpr(expr.left, fn);
      expr.right = tExpr(expr.right, fn);
      break;
    case 'UnaryExpression':
      expr.argument = tExpr(expr.argument, fn);
      break;
    case 'MemberExpression':
      expr.base = tExpr(expr.base, fn);
      break;
    case 'IndexExpression':
      expr.base = tExpr(expr.base, fn);
      expr.index = tExpr(expr.index, fn);
      break;
    case 'CallExpression':
      expr.base = tExpr(expr.base, fn);
      expr.arguments = expr.arguments.map((a) => tExpr(a, fn));
      break;
    case 'TableCallExpression':
      expr.base = tExpr(expr.base, fn);
      expr.arguments[0] = tExpr(expr.arguments[0], fn) as N.TableConstructorExpression;
      break;
    case 'StringCallExpression':
      expr.base = tExpr(expr.base, fn);
      break;
    case 'ParenthesizedExpression':
      expr.expression = tExpr(expr.expression, fn);
      break;
    case 'IfExpression':
      for (const c of expr.clauses) {
        if (c.condition) c.condition = tExpr(c.condition, fn);
        c.body = tExpr(c.body, fn);
      }
      break;
    case 'InterpolatedStringExpression':
      expr.expressions = expr.expressions.map((e) => tExpr(e, fn));
      break;
    default:
      break; // Identifier / literals: no children
  }
  const replaced = fn(expr);
  return replaced ?? expr;
}

function tStmt(stmt: N.Statement, fn: ExprTransform): N.Statement {
  switch (stmt.type) {
    case 'LocalStatement':
      stmt.init = stmt.init.map((e) => tExpr(e, fn));
      break;
    case 'CallStatement':
      stmt.expression = tExpr(stmt.expression, fn) as typeof stmt.expression;
      break;
    case 'WhileStatement':
      stmt.condition = tExpr(stmt.condition, fn);
      stmt.body = tStmts(stmt.body, fn);
      break;
    case 'RepeatStatement':
      stmt.body = tStmts(stmt.body, fn);
      stmt.condition = tExpr(stmt.condition, fn);
      break;
    case 'AssignmentStatement':
      stmt.variables = stmt.variables.map((v) => tExpr(v, fn) as N.AssignmentTarget);
      stmt.init = stmt.init.map((e) => tExpr(e, fn));
      break;
    case 'CompoundAssignmentStatement':
      stmt.variable = tExpr(stmt.variable, fn) as N.AssignmentTarget;
      stmt.value = tExpr(stmt.value, fn);
      break;
    case 'FunctionDeclaration':
      stmt.body = tStmts(stmt.body, fn);
      break;
    case 'ForNumericStatement':
      stmt.start = tExpr(stmt.start, fn);
      stmt.end = tExpr(stmt.end, fn);
      if (stmt.step) stmt.step = tExpr(stmt.step, fn);
      stmt.body = tStmts(stmt.body, fn);
      break;
    case 'ForGenericStatement':
      stmt.iterators = stmt.iterators.map((e) => tExpr(e, fn));
      stmt.body = tStmts(stmt.body, fn);
      break;
    case 'IfStatement':
      for (const c of stmt.clauses) {
        if (c.type !== 'ElseClause') c.condition = tExpr(c.condition, fn);
        c.body = tStmts(c.body, fn);
      }
      break;
    case 'DoStatement':
      stmt.body = tStmts(stmt.body, fn);
      break;
    case 'ReturnStatement':
      stmt.arguments = stmt.arguments.map((e) => tExpr(e, fn));
      break;
    default:
      break; // Break/Continue/Goto/Label: no expressions
  }
  return stmt;
}

function tStmts(stmts: N.Statement[], fn: ExprTransform): N.Statement[] {
  return stmts.map((s) => tStmt(s, fn));
}

/** Walk every expression in the chunk (including nested function bodies), bottom-up, replacing as directed. */
export function transformExpressions(chunk: N.Chunk, fn: ExprTransform): void {
  chunk.body = tStmts(chunk.body, fn);
}

export type StmtVisitor = (stmt: N.Statement) => void;

/** Visit every statement in the tree (including nested blocks), top-down. Does not recurse into expressions' own statement bodies beyond function declarations. */
export function walkStatements(stmts: N.Statement[], visit: StmtVisitor): void {
  for (const s of stmts) {
    visit(s);
    switch (s.type) {
      case 'WhileStatement':
      case 'RepeatStatement':
      case 'DoStatement':
      case 'FunctionDeclaration':
      case 'ForNumericStatement':
      case 'ForGenericStatement':
        walkStatements(s.body, visit);
        break;
      case 'IfStatement':
        for (const c of s.clauses) walkStatements(c.body, visit);
        break;
      default:
        break;
    }
  }
}
