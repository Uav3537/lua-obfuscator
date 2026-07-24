// RenameVariables: renames every local variable / parameter / for-loop
// variable / local-function name to a random `_1234`-style identifier,
// respecting lexical scoping (shadowing works the same way it did before
// renaming). Globals, table keys, and member/method names are left alone —
// only declaration sites and the identifiers that actually resolve to them
// are touched.
import * as N from '../ast/nodes';
import { randomVarName } from '../utils/random';
import { Pass } from './types';

type Scope = Map<string, string>;

function lookup(scopes: Scope[], name: string): string | null {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const hit = scopes[i].get(name);
    if (hit) return hit;
  }
  return null;
}

function declare(scopes: Scope[], allNames: Set<string>, id: N.Identifier, skip = false): void {
  if (skip || id.name === 'self') return;
  const newName = randomVarName(allNames);
  scopes[scopes.length - 1].set(id.name, newName);
  id.name = newName;
}

class Renamer {
  private allNames = new Set<string>();

  run(chunk: N.Chunk): void {
    this.block([new Map()], chunk.body);
  }

  private block(scopes: Scope[], stmts: N.Statement[]): void {
    scopes.push(new Map());
    for (const stmt of stmts) this.statement(scopes, stmt);
    scopes.pop();
  }

  private statement(scopes: Scope[], stmt: N.Statement): void {
    switch (stmt.type) {
      case 'LocalStatement':
        stmt.init.forEach((e) => this.expr(scopes, e));
        stmt.variables.forEach((v) => declare(scopes, this.allNames, v));
        break;
      case 'CallStatement':
        this.expr(scopes, stmt.expression);
        break;
      case 'WhileStatement':
        this.expr(scopes, stmt.condition);
        this.block(scopes, stmt.body);
        break;
      case 'RepeatStatement': {
        // `until` can see locals declared in the repeat body, so keep the
        // scope open across both.
        scopes.push(new Map());
        for (const s of stmt.body) this.statement(scopes, s);
        this.expr(scopes, stmt.condition);
        scopes.pop();
        break;
      }
      case 'AssignmentStatement':
        stmt.init.forEach((e) => this.expr(scopes, e));
        stmt.variables.forEach((v) => this.expr(scopes, v));
        break;
      case 'CompoundAssignmentStatement':
        this.expr(scopes, stmt.value);
        this.expr(scopes, stmt.variable);
        break;
      case 'FunctionDeclaration':
        this.functionDecl(scopes, stmt);
        break;
      case 'ForNumericStatement':
        this.expr(scopes, stmt.start);
        this.expr(scopes, stmt.end);
        if (stmt.step) this.expr(scopes, stmt.step);
        scopes.push(new Map());
        declare(scopes, this.allNames, stmt.variable);
        for (const s of stmt.body) this.statement(scopes, s);
        scopes.pop();
        break;
      case 'ForGenericStatement':
        stmt.iterators.forEach((e) => this.expr(scopes, e));
        scopes.push(new Map());
        stmt.variables.forEach((v) => declare(scopes, this.allNames, v));
        for (const s of stmt.body) this.statement(scopes, s);
        scopes.pop();
        break;
      case 'IfStatement':
        for (const c of stmt.clauses) {
          if (c.type !== 'ElseClause') this.expr(scopes, c.condition);
          this.block(scopes, c.body);
        }
        break;
      case 'DoStatement':
        this.block(scopes, stmt.body);
        break;
      case 'ReturnStatement':
        stmt.arguments.forEach((e) => this.expr(scopes, e));
        break;
      default:
        break; // Break/Continue/Goto/Label
    }
  }

  private functionDecl(scopes: Scope[], fn: N.FunctionDeclaration): void {
    if (fn.identifier) {
      if (fn.isLocal && fn.identifier.type === 'Identifier') {
        declare(scopes, this.allNames, fn.identifier);
      } else {
        // Global function name, or `function tbl.method()` / `function tbl:method()`:
        // resolve the base chain (which may be a local) but never rename the
        // trailing method/global name itself.
        this.expr(scopes, fn.identifier);
      }
    }
    scopes.push(new Map());
    for (const p of fn.parameters) {
      if (p.type === 'Identifier') declare(scopes, this.allNames, p, p.name === 'self');
    }
    for (const s of fn.body) this.statement(scopes, s);
    scopes.pop();
  }

  private expr(scopes: Scope[], expr: N.Expression): void {
    switch (expr.type) {
      case 'Identifier': {
        const resolved = lookup(scopes, expr.name);
        if (resolved) expr.name = resolved;
        break;
      }
      case 'FunctionDeclaration':
        this.functionDecl(scopes, expr);
        break;
      case 'TableConstructorExpression':
        for (const f of expr.fields) {
          if (f.type === 'TableKey') {
            this.expr(scopes, f.key);
            this.expr(scopes, f.value);
          } else {
            this.expr(scopes, f.value); // TableKeyString.key is a field name, never renamed
          }
        }
        break;
      case 'BinaryExpression':
      case 'LogicalExpression':
        this.expr(scopes, expr.left);
        this.expr(scopes, expr.right);
        break;
      case 'UnaryExpression':
        this.expr(scopes, expr.argument);
        break;
      case 'MemberExpression':
        this.expr(scopes, expr.base); // .identifier is a field name, never renamed
        break;
      case 'IndexExpression':
        this.expr(scopes, expr.base);
        this.expr(scopes, expr.index);
        break;
      case 'CallExpression':
        this.expr(scopes, expr.base);
        expr.arguments.forEach((a) => this.expr(scopes, a));
        break;
      case 'TableCallExpression':
        this.expr(scopes, expr.base);
        this.expr(scopes, expr.arguments[0]);
        break;
      case 'StringCallExpression':
        this.expr(scopes, expr.base);
        break;
      case 'ParenthesizedExpression':
        this.expr(scopes, expr.expression);
        break;
      case 'IfExpression':
        for (const c of expr.clauses) {
          if (c.condition) this.expr(scopes, c.condition);
          this.expr(scopes, c.body);
        }
        break;
      case 'InterpolatedStringExpression':
        expr.expressions.forEach((e) => this.expr(scopes, e));
        break;
      default:
        break; // literals
    }
  }
}

export const renameVariables: Pass<Record<string, never>> = (chunk) => {
  new Renamer().run(chunk);
  return chunk;
};
