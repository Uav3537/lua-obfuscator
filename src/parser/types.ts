import { TokenType } from '../lexer/tokens';
import { Cursor } from './cursor';
import {
  Type, TypeReference, TypeUnion, TypeIntersection, TypeOptional,
  TypeFunction, TypeTable, TypeTableField, TypeLiteralString, TypeLiteralBoolean,
  TypeTypeof, TypeParenthesized, TypeVariadic, TypeList, GenericTypeParameter,
  TypePack, TypePackReference, TypePackExplicit,
  Expression,
} from '../ast/nodes';

/**
 * Parser for Luau type annotations. Covers:
 *
 *   - name references + generic arguments: Foo, Foo<Bar>, Module.Foo<T, U>
 *   - union / intersection: A | B, A & B (leading |, & are also allowed: "\n| A\n| B")
 *   - optional: T?, including on a parenthesized/function group: (A | B)?, ((number) -> string)?
 *   - tables: { T }, { [K]: V }, { name: T, ... }, with mixed array/named/indexer fields
 *   - table property accessibility qualifiers: { read name: T }, { write name: T }, { read [K]: V }
 *   - functions: (number, string) -> boolean, <T>(T) -> T, including variadic
 *     params/returns: (...any) -> ...any
 *   - generic type packs: <T...>, with defaults (<T... = ...number>, <T... = (A, B)>)
 *   - type-pack arguments at a generic call site: Foo<T...>, Foo<...string>, Foo<(number, string)>
 *   - singletons: "literal", true, false
 *   - typeof(expr)
 *   - parentheses: (T)
 *
 * Not covered: Luau doesn't expose a user-writable `class` type syntax (API
 * class types like `Instance` parse as ordinary TypeReferences, so there's
 * nothing extra to implement there).
 */
export abstract class TypeParser extends Cursor {
  /** Implemented by Parser. Needed to parse the expr inside typeof(expr) */
  protected abstract parseExpression(): Expression;

  // ---- Entry point ----

  protected parseTypeAnnotation(): Type {
    // Assumes the caller (parameter/local variable/function declaration) already consumed the `:`
    return this.parseType();
  }

  protected parseType(): Type {
    return this.parseUnionType();
  }

  private parseUnionType(): Type {
    this.matchPunct('|'); // allow a leading pipe: union style spanning multiple lines
    const start = this.current();
    const first = this.parseIntersectionType();
    if (!this.checkPunct('|')) return first;

    const types: Type[] = [first];
    while (this.matchPunct('|')) {
      types.push(this.parseIntersectionType());
    }
    return { type: 'TypeUnion', types, ...this.finishRange(start) } as TypeUnion;
  }

  private parseIntersectionType(): Type {
    this.matchPunct('&'); // allow a leading ampersand
    const start = this.current();
    const first = this.parseOptionalType();
    if (!this.checkPunct('&')) return first;

    const types: Type[] = [first];
    while (this.matchPunct('&')) {
      types.push(this.parseOptionalType());
    }
    return { type: 'TypeIntersection', types, ...this.finishRange(start) } as TypeIntersection;
  }

  private parseOptionalType(): Type {
    const start = this.current();
    let base = this.parsePrimaryType();
    while (this.matchPunct('?')) {
      base = { type: 'TypeOptional', base, ...this.finishRange(start) } as TypeOptional;
    }
    return base;
  }

  // ---- Primary types ----

  private parsePrimaryType(): Type {
    const start = this.current();

    if (this.checkPunct('(')) return this.parseParenOrFunctionType();
    if (this.checkPunct('{')) return this.parseTableType();
    if (this.check(TokenType.StringLiteral)) {
      const tok = this.advance();
      return { type: 'TypeLiteralString', value: tok.value as string, ...this.finishRange(start) } as TypeLiteralString;
    }
    if (this.checkKeyword('true') || this.checkKeyword('false')) {
      // The lexer turns true/false into BooleanLiteral tokens, so execution actually falls through to the branch below
    }
    if (this.check(TokenType.BooleanLiteral)) {
      const tok = this.advance();
      return { type: 'TypeLiteralBoolean', value: tok.value as boolean, ...this.finishRange(start) } as TypeLiteralBoolean;
    }
    if (this.check(TokenType.NilLiteral)) {
      this.advance();
      return { type: 'TypeReference', name: 'nil', typeArguments: [], ...this.finishRange(start) } as TypeReference;
    }
    if (this.check(TokenType.Identifier, 'typeof')) {
      return this.parseTypeofType();
    }
    if (this.check(TokenType.Identifier) || this.checkKeyword('function')) {
      // `function` itself can't be used as a type name, but the generic
      // function type `<T>(T) -> T` is handled in the parenthesis branch, so
      // reaching here almost always means a plain name reference.
      return this.parseTypeReference();
    }
    if (this.checkPunct('<')) {
      // <T>(T) -> T  : a generic function type appearing directly with no name
      return this.parseFunctionTypeWithGenerics();
    }

    this.error(`expected a type but found ${this.current().type === TokenType.EOF ? '<eof>' : `'${this.current().raw}'`}`);
  }

  private parseTypeReference(): Type {
    const start = this.current();
    let name = this.expect(TokenType.Identifier, undefined, 'expected a type name').value as string;
    while (this.matchPunct('.')) {
      const part = this.expectIdentifierName();
      name += '.' + (part.value as string);
    }
    const typeArguments = this.checkPunct('<') ? this.parseTypeArgumentList() : [];
    return { type: 'TypeReference', name, typeArguments, ...this.finishRange(start) } as TypeReference;
  }

  private parseTypeArgumentList(): Array<Type | TypePack> {
    this.expectPunct('<');
    const args: Array<Type | TypePack> = [];
    if (!this.checkPunct('>')) {
      args.push(this.parseTypeOrTypePackArgument());
      while (this.matchPunct(',')) args.push(this.parseTypeOrTypePackArgument());
    }
    this.closeAngleBracket();
    return args;
  }

  /**
   * A single entry inside `Foo< ... >` can be an ordinary Type (the common
   * case) or a type pack, when the corresponding generic parameter was
   * declared as a pack (`<T...>`). Three type-pack forms are recognized:
   *
   *   - `Name...`      a reference to a generic pack variable, e.g. Foo<T...>
   *   - `...Type`      an explicit variadic pack, e.g. Foo<...string>
   *   - `(A, B, ...)`  an explicit pack literal, e.g. Foo<(number, string)>
   *
   * The parser doesn't track which generics were declared as packs at this
   * point (that needs semantic info this layer doesn't have), so it decides
   * purely from local syntax: only the three shapes above parse as a pack —
   * anything else, including a single parenthesized type `(T)` or a real
   * function type `(A) -> B`, still parses as an ordinary Type exactly as
   * before.
   */
  private parseTypeOrTypePackArgument(): Type | TypePack {
    // `...Type` (or bare `...`, defaulting to `any`)
    if (this.check(TokenType.VarargLiteral)) {
      const start = this.advance();
      if (this.startsType()) {
        const base = this.parseType();
        return { type: 'TypeVariadic', base, ...this.finishRange(start) } as TypeVariadic;
      }
      const anyRef: TypeReference = {
        type: 'TypeReference', name: 'any', typeArguments: [], ...this.finishRange(start),
      } as TypeReference;
      return { type: 'TypeVariadic', base: anyRef, ...this.finishRange(start) } as TypeVariadic;
    }

    // `Name...`  (a reference to a generic pack parameter, not a declaration of one)
    if (this.check(TokenType.Identifier) && this.peek(1).type === TokenType.VarargLiteral) {
      const start = this.current();
      const name = this.advance().value as string;
      this.advance(); // '...'
      return { type: 'TypePackReference', name, ...this.finishRange(start) } as TypePackReference;
    }

    // '(' ... ')': could still turn out to be a function type (if '->' follows)
    // or a single parenthesized type — only treat it as an explicit type-pack
    // literal when neither of those apply.
    if (this.checkPunct('(')) {
      const start = this.current();
      const { parameters, vararg } = this.parseFunctionParamList();

      if (this.matchPunct('->')) {
        const returns = this.parseReturnTypeList();
        let fn: Type = { type: 'TypeFunction', generics: [], parameters, vararg, returns, ...this.finishRange(start) } as TypeFunction;
        while (this.matchPunct('?')) {
          fn = { type: 'TypeOptional', base: fn, ...this.finishRange(start) } as TypeOptional;
        }
        return fn;
      }

      if (parameters.length === 1 && !vararg && parameters[0].name === null) {
        let base: Type = { type: 'TypeParenthesized', type_: parameters[0].type, ...this.finishRange(start) } as TypeParenthesized;
        while (this.matchPunct('?')) {
          base = { type: 'TypeOptional', base, ...this.finishRange(start) } as TypeOptional;
        }
        return base;
      }

      // Multiple entries (or a named/vararg entry) with no '->': an explicit type-pack literal.
      return { type: 'TypePackExplicit', types: parameters.map(p => p.type), vararg, ...this.finishRange(start) } as TypePackExplicit;
    }

    return this.parseType();
  }

  /**
   * `<`/`>` are lexed as plain Punctuators, so two of them stuck together
   * like `>>` don't get merged into a single token (that two-char combo isn't
   * in twoCharPunctuators) — but that's fine, because even nested generics
   * like `Foo<Bar<Baz>>` always lex correctly as two separate '>' tokens.
   */
  private closeAngleBracket(): void {
    this.expectPunct('>');
  }

  private parseTypeofType(): TypeTypeof {
    const start = this.current();
    this.advance(); // 'typeof'
    this.expectPunct('(');
    const expression = this.parseExpression();
    this.expectPunct(')');
    return { type: 'TypeTypeof', expression, ...this.finishRange(start) } as TypeTypeof;
  }

  private parseTableType(): TypeTable {
    const start = this.current();
    this.expectPunct('{');
    const fields: TypeTableField[] = [];

    while (!this.checkPunct('}')) {
      const access = this.tryParseTableFieldAccessQualifier();

      if (this.checkPunct('[')) {
        // [K]: V  indexer (optionally `read [K]: V` / `write [K]: V`)
        this.advance();
        const keyType = this.parseType();
        this.expectPunct(']');
        this.expectPunct(':');
        const valueType = this.parseType();
        fields.push({ key: keyType, value: valueType, access });
      } else if (this.check(TokenType.Identifier) && this.peek(1).type === TokenType.Punctuator && this.peek(1).value === ':') {
        // name: V  (optionally `read name: V` / `write name: V`)
        const name = this.advance().value as string;
        this.advance(); // ':'
        const valueType = this.parseType();
        fields.push({ key: name, value: valueType, access });
      } else {
        // Array part: just a single value type (usually the only field, like { T }).
        // Accessibility qualifiers don't apply to the array part.
        if (access !== null) {
          this.error(`'${access}' can only qualify a named property or indexer, not the array part of a table type`);
        }
        const valueType = this.parseType();
        fields.push({ key: null, value: valueType, access: null });
      }

      if (!this.matchPunct(',') && !this.matchPunct(';')) break;
    }

    this.expectPunct('}');
    return { type: 'TypeTable', fields, ...this.finishRange(start) } as TypeTable;
  }

  /**
   * `read`/`write` aren't reserved words — they're only meaningful directly
   * in front of a named property or an indexer inside a table type. So this
   * only consumes the identifier when it's actually followed by one of those
   * shapes; otherwise it's a normal field that happens to be named "read" or
   * "write" (e.g. `{ read: string }`), and nothing is consumed here.
   */
  private tryParseTableFieldAccessQualifier(): 'read' | 'write' | null {
    if (!this.check(TokenType.Identifier)) return null;
    const word = this.current().value as string;
    if (word !== 'read' && word !== 'write') return null;

    const next = this.peek(1);
    const looksLikeNamedField = next.type === TokenType.Identifier
      && this.peek(2).type === TokenType.Punctuator && this.peek(2).value === ':';
    const looksLikeIndexer = next.type === TokenType.Punctuator && next.value === '[';

    if (!looksLikeNamedField && !looksLikeIndexer) return null;

    this.advance();
    return word;
  }

  /** Having just seen '(': decide whether this is a function type `(A, B) -> C` or a plain parenthesized type `(T)`. Also handles a trailing '?' on either form: `(A | B)?`, `((A) -> B)?`. */
  private parseParenOrFunctionType(): Type {
    const start = this.current();
    const { parameters, vararg } = this.parseFunctionParamList();

    if (this.matchPunct('->')) {
      const returns = this.parseReturnTypeList();
      let fn: Type = { type: 'TypeFunction', generics: [], parameters, vararg, returns, ...this.finishRange(start) } as TypeFunction;
      while (this.matchPunct('?')) {
        fn = { type: 'TypeOptional', base: fn, ...this.finishRange(start) } as TypeOptional;
      }
      return fn;
    }

    // If it wasn't a function type, this is only a valid "type wrapped in
    // parentheses" ( T ) when there's exactly one type inside the parens.
    // (We already parsed it as an unnamed parameter, so just reuse that.)
    if (parameters.length === 1 && !vararg && parameters[0].name === null) {
      let paren: Type = { type: 'TypeParenthesized', type_: parameters[0].type, ...this.finishRange(start) } as TypeParenthesized;
      while (this.matchPunct('?')) {
        paren = { type: 'TypeOptional', base: paren, ...this.finishRange(start) } as TypeOptional;
      }
      return paren;
    }
    this.error("a parenthesized type without '->' can only contain a single type (if this was meant to be a function type, check that you didn't forget the '->')");
  }

  private parseFunctionTypeWithGenerics(): TypeFunction {
    const start = this.current();
    const generics = this.parseGenericTypeParameterList();
    const { parameters, vararg } = this.parseFunctionParamList();
    this.expectPunct('->');
    const returns = this.parseReturnTypeList();
    return { type: 'TypeFunction', generics, parameters, vararg, returns, ...this.finishRange(start) } as TypeFunction;
  }

  private parseFunctionParamList(): { parameters: Array<{ name: string | null; type: Type }>; vararg: TypeVariadic | TypePackReference | null } {
    this.expectPunct('(');
    const parameters: Array<{ name: string | null; type: Type }> = [];
    let vararg: TypeVariadic | TypePackReference | null = null;

    if (!this.checkPunct(')')) {
      for (;;) {
        // `Name...` occupying the trailing pack slot, e.g. (T...) -> () or
        // (number, T...) -> () — a reference to a generic pack parameter,
        // as opposed to `...Type` (an anonymous variadic, handled below).
        if (this.check(TokenType.Identifier) && this.peek(1).type === TokenType.VarargLiteral) {
          const start = this.current();
          const name = this.advance().value as string;
          this.advance(); // '...'
          vararg = { type: 'TypePackReference', name, ...this.finishRange(start) } as TypePackReference;
          break; // same rule as an anonymous vararg: always the last item
        }

        if (this.check(TokenType.VarargLiteral)) {
          this.advance();
          const varStart = this.previous();
          // Luau's variadic type parameter is written directly as `...Type`
          // (e.g. `(...any) -> ...any`, the type of the builtin `print`) —
          // unlike a *value* declaration's `...: Type`, there's no colon here.
          if (this.startsType()) {
            const base = this.parseType();
            vararg = { type: 'TypeVariadic', base, ...this.finishRange(varStart) } as TypeVariadic;
          } else {
            // Bare `...` with no type (treated as any)
            const anyRef: TypeReference = {
              type: 'TypeReference', name: 'any', typeArguments: [], ...this.finishRange(varStart),
            } as TypeReference;
            vararg = { type: 'TypeVariadic', base: anyRef, ...this.finishRange(varStart) } as TypeVariadic;
          }
          break; // vararg is always the last item in the parameter list
        }

        // Look ahead to tell whether this is `name: Type` or just a bare `Type` with no name
        if (this.check(TokenType.Identifier) && this.peek(1).type === TokenType.Punctuator && this.peek(1).value === ':') {
          const name = this.advance().value as string;
          this.advance(); // ':'
          const t = this.parseType();
          parameters.push({ name, type: t });
        } else {
          const t = this.parseType();
          parameters.push({ name: null, type: t });
        }

        if (!this.matchPunct(',')) break;
      }
    }
    this.expectPunct(')');
    return { parameters, vararg };
  }

  /**
   * Parses a return-type position, which can be:
   *   - a single bare type: `-> string`
   *   - a parenthesized tuple: `-> (number, string)`
   *   - `-> ...T` (variadic)
   *   - a parenthesized type that turns out to be a function type or an
   *     optional-wrapped group: `-> (number) -> string`, `-> (A | B)?`
   */
  protected parseReturnTypeList(): TypeList {
    if (this.checkPunct('(')) {
      const start = this.current();
      const { parameters, vararg } = this.parseFunctionParamList();

      // What follows the closing ')' determines what the parens actually
      // were. A bare `(A, B)` tuple can't be followed by '->' or '?' (those
      // only apply to a single grouped type), so checking for them here is
      // unambiguous.
      if (this.checkPunct('->')) {
        this.advance();
        const returns = this.parseReturnTypeList();
        let fn: Type = { type: 'TypeFunction', generics: [], parameters, vararg, returns, ...this.finishRange(start) } as TypeFunction;
        while (this.matchPunct('?')) {
          fn = { type: 'TypeOptional', base: fn, ...this.finishRange(start) } as TypeOptional;
        }
        return { types: [fn], vararg: null };
      }

      if (this.checkPunct('?')) {
        if (parameters.length !== 1 || vararg || parameters[0].name !== null) {
          this.error("a parenthesized type without '->' can only contain a single type (if this was meant to be a function type, check that you didn't forget the '->')");
        }
        let base: Type = { type: 'TypeParenthesized', type_: parameters[0].type, ...this.finishRange(start) } as TypeParenthesized;
        while (this.matchPunct('?')) {
          base = { type: 'TypeOptional', base, ...this.finishRange(start) } as TypeOptional;
        }
        return { types: [base], vararg: null };
      }

      return { types: parameters.map(p => p.type), vararg };
    }
    // `Name...` as a bare return type, e.g. `function f(): T...`
    if (this.check(TokenType.Identifier) && this.peek(1).type === TokenType.VarargLiteral) {
      const start = this.current();
      const name = this.advance().value as string;
      this.advance(); // '...'
      return { types: [], vararg: { type: 'TypePackReference', name, ...this.finishRange(start) } as TypePackReference };
    }
    if (this.check(TokenType.VarargLiteral)) {
      const start = this.advance();
      // Same `...Type` (no colon) form as in parseFunctionParamList — e.g.
      // `function f(): ...string`.
      if (this.startsType()) {
        const base = this.parseType();
        return { types: [], vararg: { type: 'TypeVariadic', base, ...this.finishRange(start) } as TypeVariadic };
      }
      const anyRef: TypeReference = {
        type: 'TypeReference', name: 'any', typeArguments: [], ...this.finishRange(start),
      } as TypeReference;
      return { types: [], vararg: { type: 'TypeVariadic', base: anyRef, ...this.finishRange(start) } as TypeVariadic };
    }
    const single = this.parseType();
    return { types: [single], vararg: null };
  }

  /** Lookahead: could a type start at the current token? Used where a type is optional (e.g. after `...`). */
  private startsType(): boolean {
    if (this.checkPunct('(') || this.checkPunct('{') || this.checkPunct('<')) return true;
    if (this.check(TokenType.StringLiteral) || this.check(TokenType.BooleanLiteral)) return true;
    if (this.check(TokenType.NilLiteral) || this.checkKeyword('true') || this.checkKeyword('false') || this.checkKeyword('function')) return true;
    if (this.check(TokenType.Identifier)) return true;
    return false;
  }

  // ---- Generic parameter list: <T, U = DefaultType, V..., W... = ...number> ----

  protected parseGenericTypeParameterList(): GenericTypeParameter[] {
    if (!this.checkPunct('<')) return [];
    this.advance();
    const params: GenericTypeParameter[] = [];
    if (!this.checkPunct('>')) {
      params.push(this.parseGenericTypeParameter());
      while (this.matchPunct(',')) params.push(this.parseGenericTypeParameter());
    }
    this.closeAngleBracket();
    return params;
  }

  private parseGenericTypeParameter(): GenericTypeParameter {
    const name = this.expectIdentifierName().value as string;

    if (this.check(TokenType.VarargLiteral)) {
      // T... : a generic type-pack parameter.
      this.advance();
      let defaultTypePack: TypePack | null = null;
      if (this.matchPunct('=')) {
        defaultTypePack = this.parseTypePackValue();
      }
      return { name, isPack: true, defaultType: null, defaultTypePack };
    }

    let defaultType: Type | null = null;
    if (this.matchPunct('=')) {
      defaultType = this.parseType();
    }
    return { name, isPack: false, defaultType, defaultTypePack: null };
  }

  /**
   * The value on the right of `=` for a generic *pack* parameter's default,
   * e.g. the `...number` in `<T... = ...number>`, the `Foo...` in
   * `<T... = Foo...>`, or the `(number, string)` in `<T... = (number, string)>`.
   */
  private parseTypePackValue(): TypePack {
    if (this.check(TokenType.VarargLiteral)) {
      const start = this.advance();
      const base = this.startsType()
        ? this.parseType()
        : ({ type: 'TypeReference', name: 'any', typeArguments: [], ...this.finishRange(start) } as TypeReference);
      return { type: 'TypeVariadic', base, ...this.finishRange(start) } as TypeVariadic;
    }
    if (this.check(TokenType.Identifier) && this.peek(1).type === TokenType.VarargLiteral) {
      const start = this.current();
      const name = this.advance().value as string;
      this.advance(); // '...'
      return { type: 'TypePackReference', name, ...this.finishRange(start) } as TypePackReference;
    }
    if (this.checkPunct('(')) {
      const start = this.current();
      const { parameters, vararg } = this.parseFunctionParamList();
      return { type: 'TypePackExplicit', types: parameters.map(p => p.type), vararg, ...this.finishRange(start) } as TypePackExplicit;
    }
    this.error(`expected a type pack (e.g. '...T', 'Name...', or '(A, B)') but found ${this.current().type === TokenType.EOF ? '<eof>' : `'${this.current().raw}'`}`);
  }
}
