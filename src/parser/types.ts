import { TokenType } from '../lexer/tokens';
import { Cursor } from './cursor';
import {
  Type, TypeReference, TypeUnion, TypeIntersection, TypeOptional,
  TypeFunction, TypeTable, TypeTableField, TypeLiteralString, TypeLiteralBoolean,
  TypeTypeof, TypeParenthesized, TypeVariadic, TypeList, GenericTypeParameter,
  Expression,
} from '../ast/nodes';

/**
 * Parser for Luau type annotations. Doesn't cover 100% of Luau's full type
 * grammar (generic packs, type-pack variables, `read`/`write` property
 * accessibility, class types, etc.), but prioritizes the forms commonly seen
 * in practice:
 *
 *   - name references + generic arguments: Foo, Foo<Bar>, Module.Foo<T, U>
 *   - union / intersection: A | B, A & B (leading |, & are also allowed: "\n| A\n| B")
 *   - optional: T?
 *   - tables: { T }, { [K]: V }, { name: T, ... }
 *   - functions: (number, string) -> boolean, <T>(T) -> T
 *   - singletons: "literal", true, false
 *   - typeof(expr)
 *   - parentheses: (T)
 *
 * TODO(planned dialect=luaU expansion):
 *   - generic type packs (`<T...>`, full type-pack semantics for `...T`)
 *   - property read/write qualifiers
 *   - class / singleton types, named table indexer combinations, and other corner cases
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
    if (this.checkKeyword('nil')) {
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

  private parseTypeArgumentList(): Type[] {
    this.expectPunct('<');
    const args: Type[] = [];
    if (!this.checkPunct('>')) {
      args.push(this.parseType());
      while (this.matchPunct(',')) args.push(this.parseType());
    }
    this.closeAngleBracket();
    return args;
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
      if (this.checkPunct('[')) {
        // [K]: V  indexer
        this.advance();
        const keyType = this.parseType();
        this.expectPunct(']');
        this.expectPunct(':');
        const valueType = this.parseType();
        fields.push({ key: keyType, value: valueType });
      } else if (this.check(TokenType.Identifier) && this.peek(1).type === TokenType.Punctuator && this.peek(1).value === ':') {
        // name: V
        const name = this.advance().value as string;
        this.advance(); // ':'
        const valueType = this.parseType();
        fields.push({ key: name, value: valueType });
      } else {
        // Array part: just a single value type (usually the only field, like { T })
        const valueType = this.parseType();
        fields.push({ key: null, value: valueType });
      }

      if (!this.matchPunct(',') && !this.matchPunct(';')) break;
    }

    this.expectPunct('}');
    return { type: 'TypeTable', fields, ...this.finishRange(start) } as TypeTable;
  }

  /** Having just seen '(': decide whether this is a function type `(A, B) -> C` or a plain parenthesized type `(T)` */
  private parseParenOrFunctionType(): Type {
    const start = this.current();
    const { parameters, vararg } = this.parseFunctionParamList();

    if (this.matchPunct('->')) {
      const returns = this.parseReturnTypeList();
      return { type: 'TypeFunction', generics: [], parameters, returns, ...this.finishRange(start) } as TypeFunction;
    }

    // If it wasn't a function type, this is only a valid "type wrapped in
    // parentheses" ( T ) when there's exactly one type inside the parens.
    // (We already parsed it as an unnamed parameter, so just reuse that.)
    if (parameters.length === 1 && !vararg && parameters[0].name === null) {
      return { type: 'TypeParenthesized', type_: parameters[0].type, ...this.finishRange(start) } as TypeParenthesized;
    }
    this.error("a parenthesized type without '->' can only contain a single type (if this was meant to be a function type, check that you didn't forget the '->')");
  }

  private parseFunctionTypeWithGenerics(): TypeFunction {
    const start = this.current();
    const generics = this.parseGenericTypeParameterList();
    const { parameters, vararg } = this.parseFunctionParamList();
    this.expectPunct('->');
    const returns = this.parseReturnTypeList();
    void vararg; // the vararg parameter is already folded in before parsing returns, separately from parameters
    return { type: 'TypeFunction', generics, parameters, returns, ...this.finishRange(start) } as TypeFunction;
  }

  private parseFunctionParamList(): { parameters: Array<{ name: string | null; type: Type }>; vararg: TypeVariadic | null } {
    this.expectPunct('(');
    const parameters: Array<{ name: string | null; type: Type }> = [];
    let vararg: TypeVariadic | null = null;

    if (!this.checkPunct(')')) {
      for (;;) {
        if (this.check(TokenType.VarargLiteral)) {
          this.advance();
          const varStart = this.previous();
          if (this.checkPunct(':')) {
            this.advance();
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

  protected parseReturnTypeList(): TypeList {
    if (this.checkPunct('(')) {
      const { parameters, vararg } = this.parseFunctionParamList();
      return { types: parameters.map(p => p.type), vararg };
    }
    if (this.check(TokenType.VarargLiteral)) {
      const start = this.advance();
      this.expectPunct(':');
      const base = this.parseType();
      return { types: [], vararg: { type: 'TypeVariadic', base, ...this.finishRange(start) } as TypeVariadic };
    }
    const single = this.parseType();
    return { types: [single], vararg: null };
  }

  // ---- Generic parameter list: <T, U = DefaultType, V...> ----

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
      // T... generic type pack. Full type-pack semantics are TODO — only the name is kept for now.
      this.advance();
      return { name: name + '...', defaultType: null };
    }
    let defaultType: Type | null = null;
    if (this.matchPunct('=')) {
      defaultType = this.parseType();
    }
    return { name, defaultType };
  }
}
