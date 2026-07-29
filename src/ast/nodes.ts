// AST node spec. The basic skeleton matches luaparse as closely as possible
// (same node names, same field names) — so luaparse-based code/tooling can be
// referenced or reused easily. Luau-only nodes don't exist in luaparse, so
// they're new additions, marked with a "(Luau)" comment after the name. When
// the dialect is lua5.1, the parser simply never constructs these nodes (this
// isn't enforced at the type level — the parser gates it via the dialect flags).

export interface Position {
  line: number;
  column: number;
}

export interface SourceLocation {
  start: Position;
  end: Position;
}

// Fields shared by every node. Unlike luaparse, where range/loc are optional,
// they're always populated here (since the obfuscator will later need to
// handle source maps/error positions).
export interface BaseNode {
  type: string;
  range: [number, number];
  loc: SourceLocation;
}

// ---------------------------------------------------------------------------
// Chunk / Block
// ---------------------------------------------------------------------------

export interface Chunk extends BaseNode {
  type: 'Chunk';
  body: Statement[];
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type Statement =
  | LocalStatement
  | CallStatement
  | WhileStatement
  | RepeatStatement
  | AssignmentStatement
  | CompoundAssignmentStatement
  | FunctionDeclaration
  | ForNumericStatement
  | ForGenericStatement
  | IfStatement
  | DoStatement
  | ReturnStatement
  | BreakStatement
  | ContinueStatement
  | GotoStatement
  | LabelStatement;

export interface LocalStatement extends BaseNode {
  type: 'LocalStatement';
  variables: Identifier[]; // each Identifier may carry .attribute / .typeAnnotation if this is Luau
  init: Expression[];
}

export interface CallStatement extends BaseNode {
  type: 'CallStatement';
  expression: CallExpression | TableCallExpression | StringCallExpression;
}

export interface WhileStatement extends BaseNode {
  type: 'WhileStatement';
  condition: Expression;
  body: Statement[];
}

export interface RepeatStatement extends BaseNode {
  type: 'RepeatStatement';
  condition: Expression;
  body: Statement[];
}

export interface AssignmentStatement extends BaseNode {
  type: 'AssignmentStatement';
  variables: AssignmentTarget[];
  init: Expression[];
}

// += -= *= /= //= %= ^= ..=  (Luau)
export interface CompoundAssignmentStatement extends BaseNode {
  type: 'CompoundAssignmentStatement';
  operator: '+=' | '-=' | '*=' | '/=' | '//=' | '%=' | '^=' | '..=';
  variable: AssignmentTarget;
  value: Expression;
}

export type AssignmentTarget = Identifier | MemberExpression | IndexExpression;

export interface FunctionDeclaration extends BaseNode {
  type: 'FunctionDeclaration';
  // null for an anonymous function (stands in for FunctionExpression). Same tradeoff as luaparse.
  identifier: Identifier | MemberExpression | null;
  isLocal: boolean;
  // true for `function obj:method()` form. In that case the parser prepends
  // an implicit `self` parameter to the front of `parameters` (Identifier, implicit: true).
  isMethod: boolean;
  parameters: FunctionParameter[];
  body: Statement[];
  hasVararg: boolean;
  varargTypeAnnotation: Type | null; // the T in (...: T) (Luau)
  // <T, U...> generic parameters (Luau)
  generics: GenericTypeParameter[];
  returnTypeAnnotation: TypeList | null; // (Luau) function f(): (number, string)
}

export type FunctionParameter = Identifier | VarargLiteral;

export interface ForNumericStatement extends BaseNode {
  type: 'ForNumericStatement';
  variable: Identifier;
  start: Expression;
  end: Expression;
  step: Expression | null;
  body: Statement[];
}

export interface ForGenericStatement extends BaseNode {
  type: 'ForGenericStatement';
  variables: Identifier[];
  iterators: Expression[];
  body: Statement[];
}

export interface IfClause extends BaseNode {
  type: 'IfClause';
  condition: Expression;
  body: Statement[];
}
export interface ElseifClause extends BaseNode {
  type: 'ElseifClause';
  condition: Expression;
  body: Statement[];
}
export interface ElseClause extends BaseNode {
  type: 'ElseClause';
  body: Statement[];
}

export interface IfStatement extends BaseNode {
  type: 'IfStatement';
  clauses: Array<IfClause | ElseifClause | ElseClause>;
}

export interface DoStatement extends BaseNode {
  type: 'DoStatement';
  body: Statement[];
}

export interface ReturnStatement extends BaseNode {
  type: 'ReturnStatement';
  arguments: Expression[];
}

export interface BreakStatement extends BaseNode {
  type: 'BreakStatement';
}

// (Luau)
export interface ContinueStatement extends BaseNode {
  type: 'ContinueStatement';
}

export interface GotoStatement extends BaseNode {
  type: 'GotoStatement';
  label: string;
}

export interface LabelStatement extends BaseNode {
  type: 'LabelStatement';
  name: string;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Expression =
  | Identifier
  | StringLiteral
  | NumericLiteral
  | BooleanLiteral
  | NilLiteral
  | VarargLiteral
  | InterpolatedStringExpression
  | FunctionDeclaration // also reused for anonymous function expressions (identifier === null)
  | TableConstructorExpression
  | BinaryExpression
  | LogicalExpression
  | UnaryExpression
  | MemberExpression
  | IndexExpression
  | CallExpression
  | TableCallExpression
  | StringCallExpression
  | ParenthesizedExpression
  | IfExpression;

// Attribute: local x <const> = 1 / local x <close> = handle  (Luau)
export interface Attribute {
  type: 'Attribute';
  name: 'const' | 'close';
}

export interface Identifier extends BaseNode {
  type: 'Identifier';
  name: string;
  // The two fields below are only populated when this Identifier appears at a
  // "declaration site" (a local variable, a function parameter). For a plain
  // reference (e.g. the `foo` in a function call) they're always null.
  attribute: Attribute['name'] | null; // (Luau)
  typeAnnotation: Type | null; // (Luau) local x: number / function f(x: number)
  // Meaningful only when isField === false (i.e. this Identifier occupies a
  // variable-name position — either a declaration or a reference). For
  // isField === true (member/method names, table-key-string names, funcname
  // trailing segments) this is set by the parser as a harmless placeholder
  // and MUST be ignored.
  //
  // The parser only knows the *syntactic* position (is this a `local`
  // declaration? a parameter?) — it cannot know whether a bare reference
  // like `foo` in `print(foo)` resolves to an enclosing local, a captured
  // upvalue, or an actual global; that requires walking the full lexical
  // scope chain. src/analysis/scope.ts's `resolveScopes()` does exactly
  // that as a pass over the whole chunk immediately after parsing. Until
  // that pass runs, every reference's `scope` is just the parser's naive
  // default ('global') and `bindingId` is null — code that needs accurate
  // scope info (rename-variables, global-mapping, vmify, ...) must run on a
  // chunk that has already been through resolveScopes().
  scope: 'global' | 'local' | 'parameter' | 'upvalue'
  isField: boolean
  // Unique id shared by a declaration and every reference that resolves to
  // it (null for globals and for isField identifiers). Two references with
  // the same bindingId are guaranteed to name the same variable even when
  // another variable of the same name shadows it somewhere in between —
  // this is what lets shadowing-safe passes work without re-deriving scope
  // from scratch. Set by resolveScopes().
  bindingId: number | null
}

export interface StringLiteral extends BaseNode {
  type: 'StringLiteral';
  value: string;
  raw: string;
  // True when this literal was synthesized by an earlier obfuscation pass
  // (e.g. a leftover chunk from StringsToExpressions) rather than coming
  // from the original source. Literal-transform passes (StringsToExpressions,
  // ConstantArray, EncryptStrings, ...) skip synthetic nodes so they don't
  // re-obfuscate each other's output and blow up the tree. Undefined is
  // treated as false.
  synthetic?: boolean;
}

export interface NumericLiteral extends BaseNode {
  type: 'NumericLiteral';
  value: number;
  raw: string;
  // Same meaning as StringLiteral.synthetic, for numbers generated by
  // NumbersToExpressions / ConstantArray / EncryptNumbers / etc.
  synthetic?: boolean;
}

export interface BooleanLiteral extends BaseNode {
  type: 'BooleanLiteral';
  value: boolean;
}

export interface NilLiteral extends BaseNode {
  type: 'NilLiteral';
}

export interface VarargLiteral extends BaseNode {
  type: 'VarargLiteral';
  value: '...';
}

// `Hello {name}, you are {age + 1} years old`  (Luau)
export interface InterpolatedStringExpression extends BaseNode {
  type: 'InterpolatedStringExpression';
  // Normalized so even indices are always string pieces (possibly empty) and
  // odd indices are always expressions: strings.length === expressions.length + 1
  strings: string[];
  expressions: Expression[];
}

export type TableField = TableKey | TableKeyString | TableValue;

// [expr] = value
export interface TableKey extends BaseNode {
  type: 'TableKey';
  key: Expression;
  value: Expression;
}
// name = value
export interface TableKeyString extends BaseNode {
  type: 'TableKeyString';
  key: Identifier;
  value: Expression;
}
// value (array part)
export interface TableValue extends BaseNode {
  type: 'TableValue';
  value: Expression;
}

export interface TableConstructorExpression extends BaseNode {
  type: 'TableConstructorExpression';
  fields: TableField[];
}

export type BinaryOperator =
  | '+' | '-' | '*' | '/' | '//' | '%' | '^'
  | '..'
  | '==' | '~=' | '<' | '<=' | '>' | '>='
  | '&' | '|' | '~' | '<<' | '>>'; // Bitwise ops only exist via the Luau standard library (bit32), there's no operator for them — types kept here for reference only

export interface BinaryExpression extends BaseNode {
  type: 'BinaryExpression';
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

// Kept separate from BinaryExpression, as luaparse does (and/or have
// different short-circuit semantics, which is convenient to distinguish in
// optimization/obfuscation passes later)
export interface LogicalExpression extends BaseNode {
  type: 'LogicalExpression';
  operator: 'and' | 'or';
  left: Expression;
  right: Expression;
}

export interface UnaryExpression extends BaseNode {
  type: 'UnaryExpression';
  operator: '-' | 'not' | '#';
  argument: Expression;
}

// base.identifier  or  base:identifier (the ':' form only appears as the base of a method call)
export interface MemberExpression extends BaseNode {
  type: 'MemberExpression';
  indexer: '.' | ':';
  base: Expression;
  identifier: Identifier;
  // true for `base?.identifier` (Luau optional chaining)
  optional: boolean;
}

// base[index]
export interface IndexExpression extends BaseNode {
  type: 'IndexExpression';
  base: Expression;
  index: Expression;
  // true for `base?[index]` (Luau optional chaining)
  optional: boolean;
}

export interface CallExpression extends BaseNode {
  type: 'CallExpression';
  base: Expression;
  arguments: Expression[];
}

// foo{...}  (calls directly with a table literal as the single argument)
export interface TableCallExpression extends BaseNode {
  type: 'TableCallExpression';
  base: Expression;
  arguments: [TableConstructorExpression];
}

// foo"..."  (calls directly with a string literal as the single argument)
export interface StringCallExpression extends BaseNode {
  type: 'StringCallExpression';
  base: Expression;
  argument: StringLiteral;
}

// Not present in luaparse, but explicitly modeled here since Lua's semantics
// of "parentheses truncate multiple return values down to one" matter for an
// obfuscator. (luaparse only tracks this as internal parser state, not on the node.)
export interface ParenthesizedExpression extends BaseNode {
  type: 'ParenthesizedExpression';
  expression: Expression;
}

// if cond then expr else expr  (Luau-only; can also form an elseif chain: if a then b elseif c then d else e)
export interface IfExpression extends BaseNode {
  type: 'IfExpression';
  clauses: Array<{ condition: Expression | null; body: Expression }>; // the last clause always has condition === null (else)
}

// ---------------------------------------------------------------------------
// Luau type annotations (a simplified subset — see the comment in types.ts)
// ---------------------------------------------------------------------------

export type Type =
  | TypeReference
  | TypeUnion
  | TypeIntersection
  | TypeOptional
  | TypeFunction
  | TypeTable
  | TypeLiteralString
  | TypeLiteralBoolean
  | TypeTypeof
  | TypeParenthesized
  | TypeVariadic;

// A "type pack" is Luau's term for the thing that can appear in a generic
// type-argument slot but isn't itself a single Type: either a reference to a
// generic pack variable declared as `T...` (TypePackReference), an explicit
// parenthesized list like `(number, string)` (TypePackExplicit), or a
// variadic `...T` (reuses TypeVariadic, already used for the same shape in
// function parameter/return vararg slots).
export type TypePack = TypeVariadic | TypePackReference | TypePackExplicit;

// A reference to a generic type-pack parameter, e.g. the `T...` in `Foo<T...>`
// (as opposed to declaring one, which is GenericTypeParameter.isPack).
export interface TypePackReference extends BaseNode {
  type: 'TypePackReference';
  name: string;
}

// An explicit, parenthesized type-pack literal used as a generic argument,
// e.g. the `(number, string)` in `Foo<(number, string)>`.
export interface TypePackExplicit extends BaseNode {
  type: 'TypePackExplicit';
  types: Type[];
  vararg: TypeVariadic | null;
}

export interface GenericTypeParameter {
  name: string;
  // true for a generic *type pack* parameter (`<T...>`) as opposed to a
  // plain generic type parameter (`<T>`). When true, only defaultTypePack
  // (never defaultType) may be populated.
  isPack: boolean;
  defaultType: Type | null;
  defaultTypePack: TypePack | null;
}

// Represents "multiple returns" for function types, etc. If it's a single type, types.length === 1.
export interface TypeList {
  types: Type[];
  // Set when a vararg type pack is appended at the end of the list — either
  // an anonymous variadic (...T, e.g. (...T)) or a reference to a named
  // generic pack parameter (T..., e.g. (T...) -> (), function f(): T...).
  vararg: TypeVariadic | TypePackReference | null;
}

export interface TypeReference extends BaseNode {
  type: 'TypeReference';
  name: string; // `Foo` or `Module.Foo` is flattened into name="Module.Foo"
  typeArguments: Array<Type | TypePack>; // Foo<Bar, Baz>, Foo<T...>, Foo<...string>, Foo<(number, string)>
}

export interface TypeUnion extends BaseNode {
  type: 'TypeUnion';
  types: Type[];
}

export interface TypeIntersection extends BaseNode {
  type: 'TypeIntersection';
  types: Type[];
}

export interface TypeOptional extends BaseNode {
  type: 'TypeOptional'; // T?
  base: Type;
}

export interface TypeFunction extends BaseNode {
  type: 'TypeFunction';
  generics: GenericTypeParameter[];
  parameters: Array<{ name: string | null; type: Type }>;
  // The trailing `...T` or `T...` parameter, if any, e.g. (...any) -> ...any
  // or (T...) -> (). Kept separate from `parameters` (matching the
  // parameter-list parse result), rather than silently dropped.
  vararg: TypeVariadic | TypePackReference | null;
  returns: TypeList;
}

export interface TypeTableField {
  // key === null means array form {T}, key: Type means an indexer {[K]: V}, key: string means {name: T}
  key: string | Type | null;
  value: Type;
  // 'read' | 'write' for { read name: T } / { write name: T }, null when unqualified (the common case, meaning both read and write)
  access: 'read' | 'write' | null;
}
export interface TypeTable extends BaseNode {
  type: 'TypeTable';
  fields: TypeTableField[];
}

// Singleton type: e.g. "foo" where the literal itself is the type
export interface TypeLiteralString extends BaseNode {
  type: 'TypeLiteralString';
  value: string;
}
export interface TypeLiteralBoolean extends BaseNode {
  type: 'TypeLiteralBoolean';
  value: boolean;
}

// typeof(expr)
export interface TypeTypeof extends BaseNode {
  type: 'TypeTypeof';
  expression: Expression;
}

export interface TypeParenthesized extends BaseNode {
  type: 'TypeParenthesized';
  type_: Type; // named with a trailing underscore since `type` is a reserved field name
}

// ...T  (element type of a variadic type pack. Full type-pack syntax
// (`...`, general generic packs) is TODO — this is currently a simplified
// version used only in the vararg slot of function params/returns)
export interface TypeVariadic extends BaseNode {
  type: 'TypeVariadic';
  base: Type;
}
