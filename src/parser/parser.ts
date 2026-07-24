import { Token, TokenType } from '../lexer/tokens';
import { Lexer } from '../lexer/lexer';
import { DialectFlags } from '../dialect';
import { TypeParser } from './types';
import { getBinaryOpInfo, isLogicalOperator, UNARY_PRECEDENCE } from './precedence';
import {
  Chunk, Statement, Expression, AssignmentTarget,
  Identifier, StringLiteral, NumericLiteral, BooleanLiteral, NilLiteral, VarargLiteral,
  InterpolatedStringExpression, TableConstructorExpression, TableField,
  BinaryExpression, LogicalExpression, UnaryExpression,
  MemberExpression, IndexExpression, CallExpression, TableCallExpression, StringCallExpression,
  ParenthesizedExpression, IfExpression,
  LocalStatement, CallStatement, WhileStatement, RepeatStatement, AssignmentStatement,
  CompoundAssignmentStatement, FunctionDeclaration, FunctionParameter,
  ForNumericStatement, ForGenericStatement, IfStatement, IfClause, ElseifClause, ElseClause,
  DoStatement, ReturnStatement, BreakStatement, ContinueStatement, GotoStatement, LabelStatement,
  BinaryOperator,
} from '../ast/nodes';

const COMPOUND_ASSIGNMENT_OPS = new Set(['+=', '-=', '*=', '/=', '//=', '%=', '^=', '..=']);

export class Parser extends TypeParser {
  constructor(tokens: Token[], dialect: DialectFlags) {
    super(tokens, dialect);
  }

  // =========================================================================
  // Entry point
  // =========================================================================

  public parseChunk(): Chunk {
    const start = this.current();
    const body = this.parseBlock();
    const eof = this.expect(TokenType.EOF, undefined, `expected <eof> but found ${this.currentDescription()}`);
    return {
      type: 'Chunk',
      body,
      range: [start.range[0], eof.range[1]],
      loc: { start: this.posOf(start), end: this.posOf(eof) },
    };
  }

  private currentDescription(): string {
    const tok = this.current();
    return tok.type === TokenType.EOF ? '<eof>' : `'${tok.raw}'`;
  }

  // =========================================================================
  // Blocks / statements
  // =========================================================================

  private isBlockEnd(): boolean {
    if (this.isAtEnd()) return true;
    return this.checkKeyword('end') || this.checkKeyword('else') || this.checkKeyword('elseif') || this.checkKeyword('until');
  }

  private parseBlock(): Statement[] {
    const stmts: Statement[] = [];
    while (!this.isBlockEnd()) {
      if (this.checkKeyword('return')) {
        stmts.push(this.parseReturnStatement());
        break; // return must be the last statement in a block
      }
      const stmt = this.parseStatement();
      if (stmt) stmts.push(stmt);
    }
    return stmts;
  }

  private parseStatement(): Statement | null {
    if (this.matchPunct(';')) return null; // empty statement

    if (this.checkKeyword('if')) return this.parseIfStatement();
    if (this.checkKeyword('while')) return this.parseWhileStatement();
    if (this.checkKeyword('do')) return this.parseDoStatement();
    if (this.checkKeyword('for')) return this.parseForStatement();
    if (this.checkKeyword('repeat')) return this.parseRepeatStatement();
    if (this.checkKeyword('function')) return this.parseFunctionStatement();
    if (this.checkKeyword('local')) return this.parseLocalStatement();
    if (this.checkKeyword('break')) return this.parseBreakStatement();
    if (this.checkKeyword('continue')) return this.parseContinueStatement(); // if dialect=lua5.1, the lexer already made this an Identifier, so we never reach here
    if (this.checkPunct('::')) return this.parseLabelStatement(); // gated inside parseLabelStatement, since '::' isn't a keyword token and can't be turned off by the lexer the way 'goto' is
    if (this.checkKeyword('goto')) return this.parseGotoStatement(); // if gotoStatements is off, the lexer already made this an Identifier, so we never reach here
    if (this.isTypeAliasStart()) return this.parseTypeAliasStatement();

    return this.parseExpressionStatement();
  }

  // ---- Individual statements ----

  private parseIfStatement(): IfStatement {
    const start = this.current();
    this.advance(); // 'if'

    const clauses: IfStatement['clauses'] = [];
    const firstClauseStart = start;
    const condition = this.parseExpression();
    this.expectKeyword('then');
    const body = this.parseBlock();
    clauses.push({ type: 'IfClause', condition, body, ...this.finishRange(firstClauseStart) } as IfClause);

    while (this.checkKeyword('elseif')) {
      const clauseStart = this.current();
      this.advance();
      const cond = this.parseExpression();
      this.expectKeyword('then');
      const b = this.parseBlock();
      clauses.push({ type: 'ElseifClause', condition: cond, body: b, ...this.finishRange(clauseStart) } as ElseifClause);
    }

    if (this.checkKeyword('else')) {
      const clauseStart = this.current();
      this.advance();
      const b = this.parseBlock();
      clauses.push({ type: 'ElseClause', body: b, ...this.finishRange(clauseStart) } as ElseClause);
    }

    this.expectKeyword('end');
    return { type: 'IfStatement', clauses, ...this.finishRange(start) };
  }

  private parseWhileStatement(): WhileStatement {
    const start = this.current();
    this.advance(); // 'while'
    const condition = this.parseExpression();
    this.expectKeyword('do');
    const body = this.parseBlock();
    this.expectKeyword('end');
    return { type: 'WhileStatement', condition, body, ...this.finishRange(start) };
  }

  private parseDoStatement(): DoStatement {
    const start = this.current();
    this.advance(); // 'do'
    const body = this.parseBlock();
    this.expectKeyword('end');
    return { type: 'DoStatement', body, ...this.finishRange(start) };
  }

  private parseRepeatStatement(): RepeatStatement {
    const start = this.current();
    this.advance(); // 'repeat'
    const body = this.parseBlock();
    this.expectKeyword('until');
    const condition = this.parseExpression();
    return { type: 'RepeatStatement', condition, body, ...this.finishRange(start) };
  }

  private parseForStatement(): ForNumericStatement | ForGenericStatement {
    const start = this.current();
    this.advance(); // 'for'
    const firstNameTok = this.expectIdentifierName();
    const firstVar = this.identifierFromToken(firstNameTok, 'local', false);

    if (this.matchPunct('=')) {
      // for i = start, end [, step] do ... end
      const from = this.parseExpression();
      this.expectPunct(',');
      const to = this.parseExpression();
      let step: Expression | null = null;
      if (this.matchPunct(',')) step = this.parseExpression();
      this.expectKeyword('do');
      const body = this.parseBlock();
      this.expectKeyword('end');
      return { type: 'ForNumericStatement', variable: firstVar, start: from, end: to, step, body, ...this.finishRange(start) };
    }

    // for a, b, c in explist do ... end
    const variables: Identifier[] = [firstVar];
    while (this.matchPunct(',')) {
      variables.push(this.identifierFromToken(this.expectIdentifierName(), 'local', false));
    }
    this.expectKeyword('in');
    const iterators = this.parseExpressionList();
    this.expectKeyword('do');
    const body = this.parseBlock();
    this.expectKeyword('end');
    return { type: 'ForGenericStatement', variables, iterators, body, ...this.finishRange(start) };
  }

  private parseFunctionStatement(): FunctionDeclaration {
    const start = this.current();
    this.advance(); // 'function'
    const { identifier, isMethod } = this.parseFuncName();
    const body = this.parseFunctionBody(isMethod);
    return { type: 'FunctionDeclaration', identifier, isLocal: false, isMethod, ...body, ...this.finishRange(start) };
  }

  /** funcname: Name {'.' Name} [':' Name] */
  private parseFuncName(): { identifier: Identifier | MemberExpression; isMethod: boolean } {
    const start = this.current();
    const nameTok = this.expectIdentifierName();
    let node: Identifier | MemberExpression = this.identifierFromToken(nameTok, 'global', false);

    while (this.matchPunct('.')) {
      const idTok = this.expectIdentifierName();
      node = {
        type: 'MemberExpression', indexer: '.', base: node, identifier: this.identifierFromToken(idTok, 'global', true), optional: false,
        ...this.finishRange(start),
      };
    }

    let isMethod = false;
    if (this.matchPunct(':')) {
      const idTok = this.expectIdentifierName();
      node = {
        type: 'MemberExpression', indexer: ':', base: node, identifier: this.identifierFromToken(idTok, 'global', true), optional: false,
        ...this.finishRange(start),
      };
      isMethod = true;
    }

    return { identifier: node, isMethod };
  }

  private parseLocalStatement(): LocalStatement | FunctionDeclaration {
    const start = this.current();
    this.advance(); // 'local'

    if (this.matchKeyword('function')) {
      const nameTok = this.expectIdentifierName();
      const identifier = this.identifierFromToken(nameTok, 'local', false);
      const body = this.parseFunctionBody(false);
      return { type: 'FunctionDeclaration', identifier, isLocal: true, isMethod: false, ...body, ...this.finishRange(start) };
    }

    const variables: Identifier[] = [];
    for (;;) {
      const nameTok = this.expectIdentifierName();
      const id = this.identifierFromToken(nameTok, 'local', false);

      if (this.checkPunct('<')) {
        if (!this.dialect.attributes) {
          this.error(`variable attributes (<const>/<close>) are Luau-only syntax (current dialect: ${this.dialect.name})`);
        }
        this.advance();
        const attrTok = this.expectIdentifierName();
        const attrName = attrTok.value as string;
        if (attrName !== 'const' && attrName !== 'close') {
          this.error(`unknown variable attribute '${attrName}' (only const or close are allowed)`);
        }
        id.attribute = attrName;
        this.expectPunct('>');
      }

      if (this.checkPunct(':')) {
        this.advance();
        if (!this.dialect.typeAnnotations) {
          this.error(`type annotations are Luau-only syntax (current dialect: ${this.dialect.name})`);
        }
        this.parseType(); // consumed for valid syntax, but intentionally not attached to the AST — Luau types are ignored entirely, not just stripped at codegen
      }

      variables.push(id);
      if (!this.matchPunct(',')) break;
    }

    let init: Expression[] = [];
    if (this.matchPunct('=')) init = this.parseExpressionList();

    return { type: 'LocalStatement', variables, init, ...this.finishRange(start) };
  }

  private parseReturnStatement(): ReturnStatement {
    const start = this.current();
    this.advance(); // 'return'
    let args: Expression[] = [];
    if (!this.isBlockEnd() && !this.checkPunct(';')) {
      args = this.parseExpressionList();
    }
    this.matchPunct(';');
    return { type: 'ReturnStatement', arguments: args, ...this.finishRange(start) };
  }

  private parseBreakStatement(): BreakStatement {
    const start = this.advance(); // 'break'
    return { type: 'BreakStatement', ...this.finishRange(start) };
  }

  private parseContinueStatement(): ContinueStatement {
    const start = this.advance(); // 'continue'
    return { type: 'ContinueStatement', ...this.finishRange(start) };
  }

  private parseGotoStatement(): GotoStatement {
    const start = this.current();
    this.advance(); // 'goto'
    const label = this.expectIdentifierName().value as string;
    return { type: 'GotoStatement', label, ...this.finishRange(start) };
  }

  private parseLabelStatement(): LabelStatement {
    const start = this.current();
    if (!this.dialect.gotoStatements) {
      this.error(
        `'::label::' is not supported (current dialect: ${this.dialect.name}) — goto/labels are a Lua 5.2+ feature; neither Lua 5.1 nor Luau implement them`
      );
    }
    this.advance(); // '::'
    const name = this.expectIdentifierName().value as string;
    this.expectPunct('::');
    return { type: 'LabelStatement', name, ...this.finishRange(start) };
  }

  /** `type`/`export` aren't reserved words — they're identifiers judged by context, so we have to look ahead before consuming them */
  private isTypeAliasStart(): boolean {
    if (!this.dialect.typeAnnotations) return false;
    if (this.check(TokenType.Identifier, 'type') && this.peek(1).type === TokenType.Identifier) return true;
    if (
      this.check(TokenType.Identifier, 'export') &&
      this.peek(1).type === TokenType.Identifier && this.peek(1).value === 'type' &&
      this.peek(2).type === TokenType.Identifier
    ) return true;
    return false;
  }

  /**
   * `type X = ...` / `export type X = ...`. Fully consumed per Luau's type
   * grammar so the parser's position stays correct, but no AST node is ever
   * built for it — the statement is ignored outright, the same as a
   * comment, rather than being represented and then stripped later.
   */
  private parseTypeAliasStatement(): null {
    if (this.check(TokenType.Identifier, 'export')) {
      this.advance();
    }
    this.advance(); // 'type'
    this.expectIdentifierName();
    this.parseGenericTypeParameterList();
    this.expectPunct('=');
    this.parseType();
    return null;
  }

  /** A statement that resolves to one of CallStatement / AssignmentStatement / CompoundAssignmentStatement */
  private parseExpressionStatement(): Statement {
    const start = this.current();
    const first = this.parseSuffixedExpression();

    const opTok = this.current();
    if (opTok.type === TokenType.Punctuator && COMPOUND_ASSIGNMENT_OPS.has(opTok.value as string)) {
      if (!this.dialect.compoundAssignment) {
        this.error(`compound assignment operator '${opTok.value}' is Luau-only syntax (current dialect: ${this.dialect.name})`);
      }
      const variable = this.toAssignmentTarget(first);
      this.advance();
      const value = this.parseExpression();
      return {
        type: 'CompoundAssignmentStatement',
        operator: opTok.value as CompoundAssignmentStatement['operator'],
        variable, value, ...this.finishRange(start),
      };
    }

    if (this.checkPunct(',') || this.checkPunct('=')) {
      const variables: AssignmentTarget[] = [this.toAssignmentTarget(first)];
      while (this.matchPunct(',')) {
        variables.push(this.toAssignmentTarget(this.parseSuffixedExpression()));
      }
      this.expectPunct('=');
      const init = this.parseExpressionList();
      return { type: 'AssignmentStatement', variables, init, ...this.finishRange(start) };
    }

    if (first.type === 'CallExpression' || first.type === 'TableCallExpression' || first.type === 'StringCallExpression') {
      return { type: 'CallStatement', expression: first, ...this.finishRange(start) };
    }

    this.error('syntax error: this expression cannot be used as a statement (it must be a call or an assignment)');
  }

  private toAssignmentTarget(expr: Expression): AssignmentTarget {
    if (expr.type === 'Identifier' || expr.type === 'MemberExpression' || expr.type === 'IndexExpression') {
      return expr;
    }
    this.error('this expression cannot be an assignment target (only a variable, obj.field, or obj[key] form is allowed)');
  }

  // =========================================================================
  // Function body (shared by statements and expressions): [<generics>] '(' params ')' [':' returnType] block 'end'
  // =========================================================================

  private parseFunctionBody(isMethod: boolean): Pick<
    FunctionDeclaration,
    'parameters' | 'body' | 'hasVararg' | 'varargTypeAnnotation' | 'generics' | 'returnTypeAnnotation'
  > {
    if (this.checkPunct('<')) {
      if (!this.dialect.genericFunctions) {
        this.error(`generic functions are Luau-only syntax (current dialect: ${this.dialect.name})`);
      }
      this.parseGenericTypeParameterList(); // consumed, not attached to the AST — types are ignored entirely
    }

    this.expectPunct('(');
    const parameters: FunctionParameter[] = [];
    if (isMethod) parameters.push(this.makeSelfIdentifier(this.previous()));

    let hasVararg = false;

    if (!this.checkPunct(')')) {
      for (;;) {
        if (this.check(TokenType.VarargLiteral)) {
          const varTok = this.advance();
          hasVararg = true;
          const varargNode: VarargLiteral = { type: 'VarargLiteral', value: '...', ...this.finishRange(varTok, varTok) };
          parameters.push(varargNode);
          if (this.checkPunct(':')) {
            this.advance();
            if (!this.dialect.typeAnnotations) {
              this.error(`type annotations are Luau-only syntax (current dialect: ${this.dialect.name})`);
            }
            this.parseType(); // consumed, not attached to the AST — types are ignored entirely
          }
          break; // vararg is always the last element in the parameter list
        }

        const nameTok = this.expectIdentifierName();
        const id = this.identifierFromToken(nameTok, 'parameter', false);
        if (this.checkPunct(':')) {
          this.advance();
          if (!this.dialect.typeAnnotations) {
            this.error(`type annotations are Luau-only syntax (current dialect: ${this.dialect.name})`);
          }
          this.parseType(); // consumed, not attached to the AST — types are ignored entirely
        }
        parameters.push(id);
        if (!this.matchPunct(',')) break;
      }
    }
    this.expectPunct(')');

    if (this.checkPunct(':')) {
      this.advance();
      if (!this.dialect.typeAnnotations) {
        this.error(`type annotations are Luau-only syntax (current dialect: ${this.dialect.name})`);
      }
      this.parseReturnTypeList(); // consumed, not attached to the AST — types are ignored entirely
    }

    const body = this.parseBlock();
    this.expectKeyword('end');

    // generics / varargTypeAnnotation / returnTypeAnnotation are always null
    // here: parsed above per Luau's grammar (to keep the token stream in
    // sync) but deliberately never attached to the AST.
    return { parameters, body, hasVararg, varargTypeAnnotation: null, generics: [], returnTypeAnnotation: null };
  }

  private makeSelfIdentifier(refTok: Token): Identifier {
    // The implicit first parameter of obj:method(). There's no token for it
    // in the actual source, so we borrow the position of the colon/method-name
    // token to fill in range/loc.
    return { type: 'Identifier', name: 'self', attribute: null, typeAnnotation: null, ...this.finishRange(refTok, refTok), scope: 'parameter', isField: false, bindingId: null };
  }

  // NOTE: `scope` here is only ever the parser's syntactic best guess
  // ('local' at a `local`/for-loop declaration site, 'parameter' for a
  // function parameter, 'global' as a placeholder everywhere else). The
  // parser has no visibility into the surrounding scope chain, so a plain
  // reference like the `x` in `print(x)` is always stamped 'global' here
  // even when it actually resolves to an enclosing local or upvalue.
  // resolveScopes() (src/analysis/scope.ts) fixes this up for every
  // non-field Identifier in a single pass immediately after parseChunk()
  // returns — nothing downstream should trust `.scope`/`.bindingId` off the
  // raw parser output.
  private identifierFromToken(tok: Token, scope: Identifier["scope"], isField: Identifier["isField"]): Identifier {
    return { type: 'Identifier', name: tok.value as string, attribute: null, typeAnnotation: null, ...this.finishRange(tok, tok), scope, isField, bindingId: null };
  }

  // =========================================================================
  // Expressions (Pratt / precedence climbing)
  // =========================================================================

  protected parseExpression(): Expression {
    return this.parseBinaryExpression(0);
  }

  private parseExpressionList(): Expression[] {
    const list = [this.parseExpression()];
    while (this.matchPunct(',')) list.push(this.parseExpression());
    return list;
  }

  private currentOperatorString(): string | null {
    const tok = this.current();
    if (tok.type === TokenType.Keyword && (tok.value === 'and' || tok.value === 'or')) return tok.value as string;
    if (tok.type === TokenType.Punctuator) return tok.value as string;
    return null;
  }

  private parseBinaryExpression(minPrecedence: number): Expression {
    const start = this.current();
    let left = this.parseUnaryExpression();

    for (;;) {
      const opStr = this.currentOperatorString();
      if (!opStr) break;
      const opInfo = getBinaryOpInfo(opStr);
      if (!opInfo || opInfo.precedence < minPrecedence) break;

      if (opStr === '//') this.requireDialectFeature(this.dialect.floorDivision, '// (integer division)');

      this.advance(); // consume the operator
      const nextMinPrecedence = opInfo.rightAssoc ? opInfo.precedence : opInfo.precedence + 1;
      const right = this.parseBinaryExpression(nextMinPrecedence);

      left = isLogicalOperator(opStr)
        ? ({ type: 'LogicalExpression', operator: opStr, left, right, ...this.finishRange(start) } as LogicalExpression)
        : ({ type: 'BinaryExpression', operator: opStr as BinaryOperator, left, right, ...this.finishRange(start) } as BinaryExpression);
    }

    return left;
  }

  private isUnaryOperatorToken(): boolean {
    return this.checkKeyword('not') || this.checkPunct('-') || this.checkPunct('#');
  }

  private parseUnaryExpression(): Expression {
    if (this.isUnaryOperatorToken()) {
      const start = this.current();
      const opTok = this.advance();
      const argument = this.parseBinaryExpression(UNARY_PRECEDENCE);
      return {
        type: 'UnaryExpression', operator: opTok.value as UnaryExpression['operator'], argument,
        ...this.finishRange(start),
      };
    }
    return this.parseCastExpression();
  }

  /**
   * Luau's type-ascription operator: `exp '::' Type`. Cast is a
   * compile-time-only annotation — it never changes the runtime value — so
   * it's parsed here (tightly, right after the suffixed/primary expression)
   * purely to consume the tokens correctly; the parsed Type is discarded
   * and the inner expression is returned completely unchanged. Chained
   * casts (`x :: any :: string`) are handled by the loop.
   */
  private parseCastExpression(): Expression {
    const expr = this.parseSuffixedExpression();
    while (this.checkPunct('::')) {
      this.advance();
      if (!this.dialect.typeAnnotations) {
        this.error(`type ascription ('::') is Luau-only syntax (current dialect: ${this.dialect.name})`);
      }
      this.parseType(); // consumed, not attached to the AST — types are ignored entirely
    }
    return expr;
  }

  /** primaryexp { '.' Name | ':' Name call | '[' exp ']' | call } */
  private parseSuffixedExpression(): Expression {
    const start = this.current();
    let expr = this.parsePrimaryAtom();

    for (;;) {
      if (this.matchPunct('.')) {
        const idTok = this.expectIdentifierName();
        expr = {
          type: 'MemberExpression', indexer: '.', base: expr, identifier: this.identifierFromToken(idTok, 'global', true), optional: false,
          ...this.finishRange(start),
        } as MemberExpression;
      } else if (this.matchPunct('[')) {
        const index = this.parseExpression();
        this.expectPunct(']');
        expr = { type: 'IndexExpression', base: expr, index, optional: false, ...this.finishRange(start) } as IndexExpression;
      } else if (this.checkPunct('?.') || this.checkPunct('?[')) {
        // Luau optional chaining: a?.b / a?[b]. The lexer glues '?' together
        // with the next character into a single token (if there's a space in
        // between they'd be different tokens, so this branch wouldn't
        // trigger), which means lua5.1 would never reach this branch anyway —
        // but we keep the dialect check here regardless, for a clear error message.
        this.requireDialectFeature(this.dialect.optionalChaining, 'optional chaining (?./?[)');
        if (this.matchPunct('?.')) {
          const idTok = this.expectIdentifierName();
          expr = {
            type: 'MemberExpression', indexer: '.', base: expr, identifier: this.identifierFromToken(idTok, 'global', true), optional: true,
            ...this.finishRange(start),
          } as MemberExpression;
        } else {
          this.advance(); // '?['
          const index = this.parseExpression();
          this.expectPunct(']');
          expr = { type: 'IndexExpression', base: expr, index, optional: true, ...this.finishRange(start) } as IndexExpression;
        }
      } else if (this.matchPunct(':')) {
        const idTok = this.expectIdentifierName();
        const member: MemberExpression = {
          type: 'MemberExpression', indexer: ':', base: expr, identifier: this.identifierFromToken(idTok, 'global', true), optional: false,
          ...this.finishRange(start),
        };
        expr = this.applyCallSuffix(member, start, true);
      } else if (this.checkPunct('(') || this.check(TokenType.StringLiteral) || this.checkPunct('{')) {
        expr = this.applyCallSuffix(expr, start, false);
      } else {
        break;
      }
    }

    return expr;
  }

  private applyCallSuffix(base: Expression, start: Token, mandatory: boolean): Expression {
    if (this.matchPunct('(')) {
      let args: Expression[] = [];
      if (!this.checkPunct(')')) args = this.parseExpressionList();
      this.expectPunct(')');
      return { type: 'CallExpression', base, arguments: args, ...this.finishRange(start) } as CallExpression;
    }
    if (this.check(TokenType.StringLiteral)) {
      const tok = this.advance();
      const argument: StringLiteral = { type: 'StringLiteral', value: tok.value as string, raw: tok.raw, ...this.finishRange(tok, tok) };
      return { type: 'StringCallExpression', base, argument, ...this.finishRange(start) } as StringCallExpression;
    }
    if (this.checkPunct('{')) {
      const table = this.parseTableConstructor();
      return { type: 'TableCallExpression', base, arguments: [table], ...this.finishRange(start) } as TableCallExpression;
    }
    if (mandatory) {
      this.error("a method call requires arguments (e.g. obj:method(...), obj:method\"str\", obj:method{...})");
    }
    // Unreachable from the general suffix loop, since it already confirmed one of the three forms before entering
    this.error('internal parser error: applyCallSuffix was entered in an invalid state');
  }

  private parsePrimaryAtom(): Expression {
    const start = this.current();

    if (this.check(TokenType.NumericLiteral)) {
      const tok = this.advance();
      return { type: 'NumericLiteral', value: tok.value as number, raw: tok.raw, ...this.finishRange(tok, tok) } as NumericLiteral;
    }
    if (this.check(TokenType.StringLiteral)) {
      const tok = this.advance();
      return { type: 'StringLiteral', value: tok.value as string, raw: tok.raw, ...this.finishRange(tok, tok) } as StringLiteral;
    }
    if (this.check(TokenType.BooleanLiteral)) {
      const tok = this.advance();
      return { type: 'BooleanLiteral', value: tok.value as boolean, ...this.finishRange(tok, tok) } as BooleanLiteral;
    }
    if (this.check(TokenType.NilLiteral)) {
      const tok = this.advance();
      return { type: 'NilLiteral', ...this.finishRange(tok, tok) } as NilLiteral;
    }
    if (this.check(TokenType.VarargLiteral)) {
      const tok = this.advance();
      return { type: 'VarargLiteral', value: '...', ...this.finishRange(tok, tok) } as VarargLiteral;
    }
    if (this.check(TokenType.InterpolatedStringLiteral)) {
      this.requireDialectFeature(this.dialect.stringInterpolation, 'string interpolation (`...{expr}...`)');
      return this.parseInterpolatedString();
    }
    if (this.checkKeyword('function')) {
      this.advance();
      const body = this.parseFunctionBody(false);
      return { type: 'FunctionDeclaration', identifier: null, isLocal: false, isMethod: false, ...body, ...this.finishRange(start) } as FunctionDeclaration;
    }
    if (this.checkPunct('{')) {
      return this.parseTableConstructor();
    }
    if (this.matchPunct('(')) {
      const expression = this.parseExpression();
      this.expectPunct(')');
      return { type: 'ParenthesizedExpression', expression, ...this.finishRange(start) } as ParenthesizedExpression;
    }
    if (this.checkKeyword('if')) {
      this.requireDialectFeature(this.dialect.ifExpression, 'if-then-else expression');
      return this.parseIfExpression();
    }
    if (this.check(TokenType.Identifier)) {
      const tok = this.advance();
      return this.identifierFromToken(tok, 'global', false);
    }

    this.error(`expected an expression but found ${this.currentDescription()}`);
  }

  private parseIfExpression(): IfExpression {
    const start = this.current();
    this.advance(); // 'if'
    const clauses: IfExpression['clauses'] = [];

    const cond = this.parseExpression();
    this.expectKeyword('then');
    const body = this.parseExpression();
    clauses.push({ condition: cond, body });

    while (this.matchKeyword('elseif')) {
      const c = this.parseExpression();
      this.expectKeyword('then');
      const b = this.parseExpression();
      clauses.push({ condition: c, body: b });
    }

    this.expectKeyword('else'); // unlike if-statements, a Luau if-expression requires an else
    const elseBody = this.parseExpression();
    clauses.push({ condition: null, body: elseBody });

    return { type: 'IfExpression', clauses, ...this.finishRange(start) };
  }

  private parseTableConstructor(): TableConstructorExpression {
    const start = this.current();
    this.expectPunct('{');
    const fields: TableField[] = [];

    while (!this.checkPunct('}')) {
      const fieldStart = this.current();
      if (this.matchPunct('[')) {
        const key = this.parseExpression();
        this.expectPunct(']');
        this.expectPunct('=');
        const value = this.parseExpression();
        fields.push({ type: 'TableKey', key, value, ...this.finishRange(fieldStart) });
      } else if (this.check(TokenType.Identifier) && this.peek(1).type === TokenType.Punctuator && this.peek(1).value === '=') {
        const idTok = this.advance();
        this.advance(); // '='
        const value = this.parseExpression();
        fields.push({ type: 'TableKeyString', key: this.identifierFromToken(idTok, 'global', true), value, ...this.finishRange(fieldStart) });
      } else {
        const value = this.parseExpression();
        fields.push({ type: 'TableValue', value, ...this.finishRange(fieldStart) });
      }

      if (!this.matchPunct(',') && !this.matchPunct(';')) break;
    }

    this.expectPunct('}');
    return { type: 'TableConstructorExpression', fields, ...this.finishRange(start) };
  }

  /** `text {expr} text` -> InterpolatedStringExpression(strings, expressions) */
  private parseInterpolatedString(): InterpolatedStringExpression {
    const start = this.current();
    const tok = this.advance();
    const parts = tok.parts ?? [];

    const strings: string[] = [];
    const expressions: Expression[] = [];

    for (const part of parts) {
      if (part.kind === 'string') {
        strings.push(part.value);
      } else {
        // NOTE(TODO): the line/column on nodes produced by the sub-parser are
        // relative to the fragment's own source, and aren't offset-corrected
        // against the full original source. If accurate error positions
        // become important, fix this by injecting a starting line/column
        // offset into Lexer/Cursor.
        const subLexer = new Lexer(part.source, this.dialect);
        const subParser = new Parser(subLexer.tokenize(), this.dialect);
        expressions.push(subParser.parseExpression());
      }
    }
    // If there was one fewer string part than expr parts (interpolation runs to the end of the string), pad it out
    if (strings.length === expressions.length) strings.push('');

    return { type: 'InterpolatedStringExpression', strings, expressions, ...this.finishRange(start) };
  }
}
