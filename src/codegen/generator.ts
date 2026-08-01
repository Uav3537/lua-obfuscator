// AST -> Lua/Luau source printer. This is intentionally not a pretty-printer
// (no attempt at nice line wrapping) — obfuscation passes want compact,
// syntactically valid output, not readable output.

import * as N from '../ast/nodes';

const BIN_PRECEDENCE: Record<string, number> = {
  or: 1,
  and: 2,
  '<': 3, '>': 3, '<=': 3, '>=': 3, '~=': 3, '==': 3,
  '|': 4,
  '~': 5,
  '&': 6,
  '<<': 7, '>>': 7,
  '..': 9,
  '+': 10, '-': 10,
  '*': 11, '/': 11, '//': 11, '%': 11,
  '^': 14,
};
const UNARY_PRECEDENCE = 12;
const RIGHT_ASSOC = new Set(['..', '^']);

export interface GeneratorOptions {
  /** Emit everything on a single line, statements separated by `;`, instead of pretty-printed/indented. */
  minify?: boolean;
}

export class Generator {
  private indentLevel = 0;
  private readonly minify: boolean;

  constructor(options: GeneratorOptions = {}) {
    this.minify = options.minify ?? false;
  }

  private indent(): string {
    return this.minify ? '' : '  '.repeat(this.indentLevel);
  }

  generate(chunk: N.Chunk): string {
    return this.printBlock(chunk.body);
  }

  printBlock(stmts: N.Statement[]): string {
    if (this.minify) {
      return stmts.map((s) => this.printStatement(s)).join('; ');
    }
    return stmts.map((s) => this.indent() + this.printStatement(s)).join('\n');
  }

  private withIndent(fn: () => string): string {
    this.indentLevel++;
    const out = fn();
    this.indentLevel--;
    return out;
  }

  /**
   * Renders `head <body> tail` (e.g. `while x do`, block, `end`) in either
   * pretty-printed (indented, multi-line) or minified (single-line,
   * `;`-separated body) form depending on `this.minify`.
   */
  private wrapBlock(head: string, body: N.Statement[], tail: string): string {
    const inner = this.withIndent(() => this.printBlock(body));
    if (this.minify) {
      return inner.length ? `${head} ${inner} ${tail}` : `${head} ${tail}`;
    }
    return `${head}\n${inner}\n${this.indent()}${tail}`;
  }

  // -------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------

  printStatement(stmt: N.Statement): string {
    switch (stmt.type) {
      case 'LocalStatement': {
        const vars = stmt.variables.map((v) => this.printIdentifierDecl(v)).join(', ');
        if (stmt.init.length === 0) return `local ${vars}`;
        return `local ${vars} = ${stmt.init.map((e) => this.printExpr(e)).join(', ')}`;
      }
      case 'CallStatement':
        return this.printExpr(stmt.expression);
      case 'WhileStatement':
        return this.wrapBlock(`while ${this.printExpr(stmt.condition)} do`, stmt.body, 'end');
      case 'RepeatStatement':
        return this.wrapBlock('repeat', stmt.body, `until ${this.printExpr(stmt.condition)}`);
      case 'AssignmentStatement':
        return `${stmt.variables.map((v) => this.printExpr(v)).join(', ')} = ${stmt.init
          .map((e) => this.printExpr(e))
          .join(', ')}`;
      case 'CompoundAssignmentStatement': {
        // Always desugar to a plain assignment (`x = x + y`), even when the
        // target dialect is Luau. `+=`/`-=`/etc. are Luau-only syntax — Lua
        // 5.1 (and any plain-Lua runtime this output might end up on,
        // regardless of what dialect the source was parsed with) has no
        // such operator and would hit a syntax error on it. The desugared
        // form is valid everywhere. This re-prints `variable` twice, which
        // is only safe because every AssignmentTarget this project produces
        // (Identifier / MemberExpression / IndexExpression built from an
        // Identifier or literal-key chain) is side-effect-free to
        // evaluate twice.
        const op = stmt.operator.slice(0, -1); // '+=' -> '+', '..=' -> '..'
        const target = this.printExpr(stmt.variable);
        return `${target} = ${target} ${op} ${this.printExpr(stmt.value)}`;
      }
      case 'FunctionDeclaration':
        return this.printFunctionDeclaration(stmt);
      case 'ForNumericStatement': {
        const step = stmt.step ? `, ${this.printExpr(stmt.step)}` : '';
        return this.wrapBlock(
          `for ${stmt.variable.name} = ${this.printExpr(stmt.start)}, ${this.printExpr(stmt.end)}${step} do`,
          stmt.body,
          'end'
        );
      }
      case 'ForGenericStatement':
        return this.wrapBlock(
          `for ${stmt.variables.map((v) => v.name).join(', ')} in ${stmt.iterators
            .map((e) => this.printExpr(e))
            .join(', ')} do`,
          stmt.body,
          'end'
        );
      case 'IfStatement':
        return this.printIfStatement(stmt);
      case 'DoStatement':
        return this.wrapBlock('do', stmt.body, 'end');
      case 'ReturnStatement':
        return stmt.arguments.length
          ? `return ${stmt.arguments.map((e) => this.printExpr(e)).join(', ')}`
          : 'return';
      case 'BreakStatement':
        return 'break';
      case 'ContinueStatement':
        return 'continue';
      case 'GotoStatement':
        return `goto ${stmt.label}`;
      case 'LabelStatement':
        return `::${stmt.name}::`;
      default:
        throw new Error(`Generator: unhandled statement type ${(stmt as N.Statement).type}`);
    }
  }

  private printIdentifierDecl(id: N.Identifier): string {
    const attr = id.attribute ? ` <${id.attribute}>` : '';
    return `${id.name}${attr}`;
  }

  private printIfStatement(stmt: N.IfStatement): string {
    // Only one `end` closes the whole if/elseif/.../else chain, so this can't
    // reuse wrapBlock (which always appends its own tail) — same head+inner
    // logic, just accumulated across every clause first.
    let out = '';
    for (let i = 0; i < stmt.clauses.length; i++) {
      const clause = stmt.clauses[i];
      let head: string;
      if (clause.type === 'IfClause') head = `if ${this.printExpr(clause.condition)} then`;
      else if (clause.type === 'ElseifClause') head = `elseif ${this.printExpr(clause.condition)} then`;
      else head = 'else';

      const inner = this.withIndent(() => this.printBlock(clause.body));
      if (this.minify) {
        out += inner.length ? `${head} ${inner} ` : `${head} `;
      } else {
        out += `${head}\n${inner}\n${this.indent()}`;
      }
    }
    return out + 'end';
  }

  private printFunctionDeclaration(fn: N.FunctionDeclaration): string {
    // The parser prepends an implicit `self` param for `function obj:method()`
    // declarations — Lua's `:` syntax re-adds that itself, so don't print it twice.
    const visibleParams = fn.isMethod ? fn.parameters.slice(1) : fn.parameters;
    const params = visibleParams
      .map((p) => (p.type === 'VarargLiteral' ? '...' : p.name))
      .join(', ');
    const kw = fn.isLocal ? 'local function' : 'function';
    const nameStr = fn.identifier ? this.printExpr(fn.identifier as N.Expression) : '';
    const head = fn.identifier ? `${kw} ${nameStr}(${params})` : `function(${params})`;
    return this.wrapBlock(head, fn.body, 'end');
  }

  // -------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------

  printExpr(expr: N.Expression, parentPrec = 0): string {
    switch (expr.type) {
      case 'Identifier':
        return expr.name;
      case 'StringLiteral':
        return expr.literalText ?? printStringLiteral(expr.value);
      case 'NumericLiteral':
        return formatNumber(expr.value);
      case 'BooleanLiteral':
        return expr.value ? 'true' : 'false';
      case 'NilLiteral':
        return 'nil';
      case 'VarargLiteral':
        return '...';
      case 'InterpolatedStringExpression':
        return this.printInterpolatedString(expr);
      case 'FunctionDeclaration':
        return this.printFunctionDeclaration(expr);
      case 'TableConstructorExpression':
        return this.printTableConstructor(expr);
      case 'BinaryExpression':
        return this.printBinary(expr.operator, expr.left, expr.right, parentPrec);
      case 'LogicalExpression':
        return this.printBinary(expr.operator, expr.left, expr.right, parentPrec);
      case 'UnaryExpression': {
        const opStr = expr.operator === 'not' ? 'not ' : expr.operator;
        const inner = `${opStr}${this.printExpr(expr.argument, UNARY_PRECEDENCE)}`;
        return UNARY_PRECEDENCE < parentPrec ? `(${inner})` : inner;
      }
      case 'MemberExpression':
        return `${this.printExpr(expr.base, 100)}${expr.optional ? '?' : ''}${expr.indexer}${
          expr.identifier.name
        }`;
      case 'IndexExpression':
        return `${this.printExpr(expr.base, 100)}${expr.optional ? '?' : ''}[${this.printExpr(
          expr.index
        )}]`;
      case 'CallExpression':
        return `${this.printExpr(expr.base, 100)}(${expr.arguments
          .map((a) => this.printExpr(a))
          .join(', ')})`;
      case 'TableCallExpression':
        return `${this.printExpr(expr.base, 100)}${this.printTableConstructor(expr.arguments[0])}`;
      case 'StringCallExpression':
        return `${this.printExpr(expr.base, 100)}${printStringLiteral(expr.argument.value)}`;
      case 'ParenthesizedExpression':
        return `(${this.printExpr(expr.expression)})`;
      case 'IfExpression':
        return this.printIfExpression(expr);
      default:
        throw new Error(`Generator: unhandled expression type ${(expr as N.Expression).type}`);
    }
  }

  private printBinary(op: string, left: N.Expression, right: N.Expression, parentPrec: number): string {
    const prec = BIN_PRECEDENCE[op] ?? 5;
    const rightAssoc = RIGHT_ASSOC.has(op);
    const leftStr = this.printExpr(left, rightAssoc ? prec + 1 : prec);
    const rightStr = this.printExpr(right, rightAssoc ? prec : prec + 1);
    const inner = `${leftStr} ${op} ${rightStr}`;
    return prec < parentPrec ? `(${inner})` : inner;
  }

  private printTableConstructor(t: N.TableConstructorExpression): string {
    const fields = t.fields.map((f) => {
      if (f.type === 'TableKey') return `[${this.printExpr(f.key)}] = ${this.printExpr(f.value)}`;
      if (f.type === 'TableKeyString') return `${f.key.name} = ${this.printExpr(f.value)}`;
      return this.printExpr(f.value);
    });
    return `{${fields.join(', ')}}`;
  }

  private printInterpolatedString(e: N.InterpolatedStringExpression): string {
    // Lower to plain concatenation for maximum compatibility with downstream passes.
    const parts: string[] = [];
    for (let i = 0; i < e.strings.length; i++) {
      if (e.strings[i] !== '') parts.push(printStringLiteral(e.strings[i]));
      if (i < e.expressions.length) {
        parts.push(`tostring(${this.printExpr(e.expressions[i])})`);
      }
    }
    if (parts.length === 0) return `""`;
    return parts.join(' .. ');
  }

  private printIfExpression(e: N.IfExpression): string {
    let out = '';
    for (let i = 0; i < e.clauses.length; i++) {
      const c = e.clauses[i];
      if (c.condition === null) {
        out += `else ${this.printExpr(c.body)}`;
      } else if (i === 0) {
        out += `if ${this.printExpr(c.condition)} then ${this.printExpr(c.body)} `;
      } else {
        out += `elseif ${this.printExpr(c.condition)} then ${this.printExpr(c.body)} `;
      }
    }
    return out.trim();
  }
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  return n.toString();
}

/**
 * Prints a Luau string literal from a raw byte array (0-255 each), NOT from
 * Unicode codepoints. Used for binary/encrypted payloads (e.g. EncryptStrings)
 * where every value is an exact byte that must round-trip through
 * string.byte()/string.char() unchanged. Unlike printStringLiteral, this never
 * treats a value as a multi-byte Unicode codepoint - every byte >= 128 is
 * escaped as \\ddd so it can't be misinterpreted as part of a UTF-8 sequence.
 */
export function printByteStringLiteral(bytes: number[]): string {
  let out = '"';
  for (const b of bytes) {
    if (b === '"'.charCodeAt(0)) out += '\\"';
    else if (b === '\\'.charCodeAt(0)) out += '\\\\';
    else if (b === 10) out += '\\n';
    else if (b === 13) out += '\\r';
    else if (b === 9) out += '\\t';
    else if (b < 32 || b >= 127) out += `\\${String(b).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return out + '"';
}

export function printStringLiteral(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 32 || code === 127) out += `\\${String(code).padStart(3, '0')}`;
    else out += ch;
  }
  return out + '"';
}

export function generate(chunk: N.Chunk, options: GeneratorOptions = {}): string {
  return new Generator(options).generate(chunk);
}
