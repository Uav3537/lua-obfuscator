import * as N from '../ast/nodes';

export type BindingKind = 'local' | 'parameter' | 'for-loop' | 'for-in' | 'local-function';

export interface Binding {
  id: number;
  name: string;
  kind: BindingKind;
  declaration: N.Identifier;
}

interface Frame {
  parent: Frame | null;
  functionDepth: number;
  bindings: Map<string, Binding>;
}

class Resolver {
  private nextBindingId = 0;
  private functionDepth = 0;
  private top: Frame = { parent: null, functionDepth: 0, bindings: new Map() };

  private pushBlock(): void {
    this.top = { parent: this.top, functionDepth: this.functionDepth, bindings: new Map() };
  }

  private pushFunction(): void {
    this.functionDepth++;
    this.top = { parent: this.top, functionDepth: this.functionDepth, bindings: new Map() };
  }

  private pop(): void {
    this.top = this.top.parent!;
  }

  private popFunction(): void {
    this.top = this.top.parent!;
    this.functionDepth--;
  }

  private declare(id: N.Identifier, kind: BindingKind): void {
    const binding: Binding = { id: this.nextBindingId++, name: id.name, kind, declaration: id };
    this.top.bindings.set(id.name, binding);
    id.bindingId = binding.id;
    id.scope = kind === 'parameter' ? 'parameter' : 'local';
  }

  private resolveReference(id: N.Identifier): void {
    if (id.isField) return;

    let frame: Frame | null = this.top;
    while (frame) {
      const binding = frame.bindings.get(id.name);
      if (binding) {
        id.bindingId = binding.id;
        id.scope = frame.functionDepth === this.functionDepth
          ? (binding.kind === 'parameter' ? 'parameter' : 'local')
          : 'upvalue';
        return;
      }
      frame = frame.parent;
    }

    id.bindingId = null;
    id.scope = 'global';
  }

  run(chunk: N.Chunk): void {
    this.block(chunk.body);
  }

  private block(stmts: N.Statement[]): void {
    this.pushBlock();
    for (const stmt of stmts) this.statement(stmt);
    this.pop();
  }

  private statement(stmt: N.Statement): void {
    switch (stmt.type) {
      case 'LocalStatement':
        stmt.init.forEach((e) => this.expr(e));
        stmt.variables.forEach((v) => {
          this.visitType(v.typeAnnotation);
          this.declare(v, 'local');
        });
        break;
      case 'CallStatement':
        this.expr(stmt.expression);
        break;
      case 'WhileStatement':
        this.expr(stmt.condition);
        this.block(stmt.body);
        break;
      case 'RepeatStatement':
        this.pushBlock();
        for (const s of stmt.body) this.statement(s);
        this.expr(stmt.condition);
        this.pop();
        break;
      case 'AssignmentStatement':
        stmt.init.forEach((e) => this.expr(e));
        stmt.variables.forEach((v) => this.expr(v));
        break;
      case 'CompoundAssignmentStatement':
        this.expr(stmt.value);
        this.expr(stmt.variable);
        break;
      case 'FunctionDeclaration':
        this.functionDecl(stmt);
        break;
      case 'ForNumericStatement':
        this.expr(stmt.start);
        this.expr(stmt.end);
        if (stmt.step) this.expr(stmt.step);
        this.pushBlock();
        this.declare(stmt.variable, 'for-loop');
        for (const s of stmt.body) this.statement(s);
        this.pop();
        break;
      case 'ForGenericStatement':
        stmt.iterators.forEach((e) => this.expr(e));
        this.pushBlock();
        stmt.variables.forEach((v) => this.declare(v, 'for-in'));
        for (const s of stmt.body) this.statement(s);
        this.pop();
        break;
      case 'IfStatement':
        for (const c of stmt.clauses) {
          if (c.type !== 'ElseClause') this.expr(c.condition);
          this.block(c.body);
        }
        break;
      case 'DoStatement':
        this.block(stmt.body);
        break;
      case 'ReturnStatement':
        stmt.arguments.forEach((e) => this.expr(e));
        break;
      default:
        break;
    }
  }

  private functionDecl(fn: N.FunctionDeclaration): void {
    if (fn.identifier) {
      if (fn.isLocal && fn.identifier.type === 'Identifier') {
        this.declare(fn.identifier, 'local-function');
      } else {
        this.expr(fn.identifier);
      }
    }

    this.pushFunction();
    for (const p of fn.parameters) {
      if (p.type === 'Identifier') {
        this.visitType(p.typeAnnotation);
        this.declare(p, 'parameter');
      }
    }
    fn.generics.forEach((g) => this.visitType(g.defaultType));
    this.visitType(fn.varargTypeAnnotation);
    this.visitTypeList(fn.returnTypeAnnotation);
    for (const s of fn.body) this.statement(s);
    this.popFunction();
  }

  private expr(expr: N.Expression): void {
    switch (expr.type) {
      case 'Identifier':
        this.resolveReference(expr);
        break;
      case 'FunctionDeclaration':
        this.functionDecl(expr);
        break;
      case 'TableConstructorExpression':
        for (const f of expr.fields) {
          if (f.type === 'TableKey') {
            this.expr(f.key);
            this.expr(f.value);
          } else {
            this.expr(f.value);
          }
        }
        break;
      case 'BinaryExpression':
      case 'LogicalExpression':
        this.expr(expr.left);
        this.expr(expr.right);
        break;
      case 'UnaryExpression':
        this.expr(expr.argument);
        break;
      case 'MemberExpression':
        this.expr(expr.base);
        break;
      case 'IndexExpression':
        this.expr(expr.base);
        this.expr(expr.index);
        break;
      case 'CallExpression':
        this.expr(expr.base);
        expr.arguments.forEach((a) => this.expr(a));
        break;
      case 'TableCallExpression':
        this.expr(expr.base);
        this.expr(expr.arguments[0]);
        break;
      case 'StringCallExpression':
        this.expr(expr.base);
        break;
      case 'ParenthesizedExpression':
        this.expr(expr.expression);
        break;
      case 'IfExpression':
        for (const c of expr.clauses) {
          if (c.condition) this.expr(c.condition);
          this.expr(c.body);
        }
        break;
      case 'InterpolatedStringExpression':
        expr.expressions.forEach((e) => this.expr(e));
        break;
      default:
        break; // literals: StringLiteral / NumericLiteral / BooleanLiteral / NilLiteral / VarargLiteral
    }
  }

  // ---- Luau type annotations ----
  // Types live in their own namespace (a TypeReference's `name` is a plain
  // string, not an Identifier) so most of a type tree has nothing to
  // resolve. The one exception is `typeof(expr)`, which embeds a real
  // value-level Expression that must see the current scope.

  private visitTypeList(list: N.TypeList | null): void {
    if (!list) return;
    list.types.forEach((t) => this.visitType(t));
    if (list.vararg) this.visitTypeOrPack(list.vararg);
  }

  private visitType(type: N.Type | null): void {
    if (!type) return;
    switch (type.type) {
      case 'TypeTypeof':
        this.expr(type.expression);
        break;
      case 'TypeUnion':
      case 'TypeIntersection':
        type.types.forEach((t) => this.visitType(t));
        break;
      case 'TypeOptional':
        this.visitType(type.base);
        break;
      case 'TypeParenthesized':
        this.visitType(type.type_);
        break;
      case 'TypeVariadic':
        this.visitType(type.base);
        break;
      case 'TypeFunction':
        type.parameters.forEach((p) => this.visitType(p.type));
        if (type.vararg) this.visitTypeOrPack(type.vararg);
        this.visitTypeList(type.returns);
        break;
      case 'TypeTable':
        for (const f of type.fields) {
          if (f.key && typeof f.key !== 'string') this.visitType(f.key);
          this.visitType(f.value);
        }
        break;
      case 'TypeReference':
        type.typeArguments.forEach((t) => this.visitTypeOrPack(t));
        break;
      default:
        break; // TypeLiteralString / TypeLiteralBoolean: nothing to resolve
    }
  }

  /** A generic type argument can be a plain Type or a TypePack (Foo<T...>, Foo<...string>, Foo<(A, B)>). */
  private visitTypeOrPack(t: N.Type | N.TypePack): void {
    switch (t.type) {
      case 'TypePackReference':
        break; // just a name into the pack namespace, nothing to resolve
      case 'TypePackExplicit':
        t.types.forEach((tt) => this.visitType(tt));
        if (t.vararg) this.visitType(t.vararg);
        break;
      default:
        this.visitType(t as N.Type);
        break;
    }
  }
}

/**
 * Resolves every Identifier's lexical scope in place, mutating the tree.
 * Run this once, right after parsing and before any obfuscation pass reads
 * `.scope` / `.bindingId` — renaming, global-mapping, vmify, etc. all depend
 * on this having already run.
 */
export function resolveScopes(chunk: N.Chunk): N.Chunk {
  new Resolver().run(chunk);
  return chunk;
}
