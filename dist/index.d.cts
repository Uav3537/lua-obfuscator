type DialectName = 'lua5.1' | 'luaU';
declare class UnknownDialectError extends Error {
    constructor(given: string);
}

interface Position {
    line: number;
    column: number;
}
interface SourceLocation {
    start: Position;
    end: Position;
}
interface BaseNode {
    type: string;
    range: [number, number];
    loc: SourceLocation;
}
interface Chunk extends BaseNode {
    type: 'Chunk';
    body: Statement[];
}
type Statement = LocalStatement | CallStatement | WhileStatement | RepeatStatement | AssignmentStatement | CompoundAssignmentStatement | FunctionDeclaration | ForNumericStatement | ForGenericStatement | IfStatement | DoStatement | ReturnStatement | BreakStatement | ContinueStatement | GotoStatement | LabelStatement;
interface LocalStatement extends BaseNode {
    type: 'LocalStatement';
    variables: Identifier[];
    init: Expression[];
}
interface CallStatement extends BaseNode {
    type: 'CallStatement';
    expression: CallExpression | TableCallExpression | StringCallExpression;
}
interface WhileStatement extends BaseNode {
    type: 'WhileStatement';
    condition: Expression;
    body: Statement[];
}
interface RepeatStatement extends BaseNode {
    type: 'RepeatStatement';
    condition: Expression;
    body: Statement[];
}
interface AssignmentStatement extends BaseNode {
    type: 'AssignmentStatement';
    variables: AssignmentTarget[];
    init: Expression[];
}
interface CompoundAssignmentStatement extends BaseNode {
    type: 'CompoundAssignmentStatement';
    operator: '+=' | '-=' | '*=' | '/=' | '//=' | '%=' | '^=' | '..=';
    variable: AssignmentTarget;
    value: Expression;
}
type AssignmentTarget = Identifier | MemberExpression | IndexExpression;
interface FunctionDeclaration extends BaseNode {
    type: 'FunctionDeclaration';
    identifier: Identifier | MemberExpression | null;
    isLocal: boolean;
    isMethod: boolean;
    parameters: FunctionParameter[];
    body: Statement[];
    hasVararg: boolean;
    varargTypeAnnotation: Type | null;
    generics: GenericTypeParameter[];
    returnTypeAnnotation: TypeList | null;
}
type FunctionParameter = Identifier | VarargLiteral;
interface ForNumericStatement extends BaseNode {
    type: 'ForNumericStatement';
    variable: Identifier;
    start: Expression;
    end: Expression;
    step: Expression | null;
    body: Statement[];
}
interface ForGenericStatement extends BaseNode {
    type: 'ForGenericStatement';
    variables: Identifier[];
    iterators: Expression[];
    body: Statement[];
}
interface IfClause extends BaseNode {
    type: 'IfClause';
    condition: Expression;
    body: Statement[];
}
interface ElseifClause extends BaseNode {
    type: 'ElseifClause';
    condition: Expression;
    body: Statement[];
}
interface ElseClause extends BaseNode {
    type: 'ElseClause';
    body: Statement[];
}
interface IfStatement extends BaseNode {
    type: 'IfStatement';
    clauses: Array<IfClause | ElseifClause | ElseClause>;
}
interface DoStatement extends BaseNode {
    type: 'DoStatement';
    body: Statement[];
}
interface ReturnStatement extends BaseNode {
    type: 'ReturnStatement';
    arguments: Expression[];
}
interface BreakStatement extends BaseNode {
    type: 'BreakStatement';
}
interface ContinueStatement extends BaseNode {
    type: 'ContinueStatement';
}
interface GotoStatement extends BaseNode {
    type: 'GotoStatement';
    label: string;
}
interface LabelStatement extends BaseNode {
    type: 'LabelStatement';
    name: string;
}
type Expression = Identifier | StringLiteral | NumericLiteral | BooleanLiteral | NilLiteral | VarargLiteral | InterpolatedStringExpression | FunctionDeclaration | TableConstructorExpression | BinaryExpression | LogicalExpression | UnaryExpression | MemberExpression | IndexExpression | CallExpression | TableCallExpression | StringCallExpression | ParenthesizedExpression | IfExpression;
interface Attribute {
    type: 'Attribute';
    name: 'const' | 'close';
}
interface Identifier extends BaseNode {
    type: 'Identifier';
    name: string;
    attribute: Attribute['name'] | null;
    typeAnnotation: Type | null;
    scope: 'global' | 'local' | 'parameter' | 'upvalue';
    isField: boolean;
    bindingId: number | null;
}
interface StringLiteral extends BaseNode {
    type: 'StringLiteral';
    value: string;
    raw: string;
    literalText?: string;
    synthetic?: boolean;
}
interface NumericLiteral extends BaseNode {
    type: 'NumericLiteral';
    value: number;
    raw: string;
    synthetic?: boolean;
}
interface BooleanLiteral extends BaseNode {
    type: 'BooleanLiteral';
    value: boolean;
}
interface NilLiteral extends BaseNode {
    type: 'NilLiteral';
}
interface VarargLiteral extends BaseNode {
    type: 'VarargLiteral';
    value: '...';
}
interface InterpolatedStringExpression extends BaseNode {
    type: 'InterpolatedStringExpression';
    strings: string[];
    expressions: Expression[];
}
type TableField = TableKey | TableKeyString | TableValue;
interface TableKey extends BaseNode {
    type: 'TableKey';
    key: Expression;
    value: Expression;
}
interface TableKeyString extends BaseNode {
    type: 'TableKeyString';
    key: Identifier;
    value: Expression;
}
interface TableValue extends BaseNode {
    type: 'TableValue';
    value: Expression;
}
interface TableConstructorExpression extends BaseNode {
    type: 'TableConstructorExpression';
    fields: TableField[];
}
type BinaryOperator = '+' | '-' | '*' | '/' | '//' | '%' | '^' | '..' | '==' | '~=' | '<' | '<=' | '>' | '>=' | '&' | '|' | '~' | '<<' | '>>';
interface BinaryExpression extends BaseNode {
    type: 'BinaryExpression';
    operator: BinaryOperator;
    left: Expression;
    right: Expression;
}
interface LogicalExpression extends BaseNode {
    type: 'LogicalExpression';
    operator: 'and' | 'or';
    left: Expression;
    right: Expression;
}
interface UnaryExpression extends BaseNode {
    type: 'UnaryExpression';
    operator: '-' | 'not' | '#';
    argument: Expression;
}
interface MemberExpression extends BaseNode {
    type: 'MemberExpression';
    indexer: '.' | ':';
    base: Expression;
    identifier: Identifier;
    optional: boolean;
}
interface IndexExpression extends BaseNode {
    type: 'IndexExpression';
    base: Expression;
    index: Expression;
    optional: boolean;
}
interface CallExpression extends BaseNode {
    type: 'CallExpression';
    base: Expression;
    arguments: Expression[];
}
interface TableCallExpression extends BaseNode {
    type: 'TableCallExpression';
    base: Expression;
    arguments: [TableConstructorExpression];
}
interface StringCallExpression extends BaseNode {
    type: 'StringCallExpression';
    base: Expression;
    argument: StringLiteral;
}
interface ParenthesizedExpression extends BaseNode {
    type: 'ParenthesizedExpression';
    expression: Expression;
}
interface IfExpression extends BaseNode {
    type: 'IfExpression';
    clauses: Array<{
        condition: Expression | null;
        body: Expression;
    }>;
}
type Type = TypeReference | TypeUnion | TypeIntersection | TypeOptional | TypeFunction | TypeTable | TypeLiteralString | TypeLiteralBoolean | TypeTypeof | TypeParenthesized | TypeVariadic;
type TypePack = TypeVariadic | TypePackReference | TypePackExplicit;
interface TypePackReference extends BaseNode {
    type: 'TypePackReference';
    name: string;
}
interface TypePackExplicit extends BaseNode {
    type: 'TypePackExplicit';
    types: Type[];
    vararg: TypeVariadic | null;
}
interface GenericTypeParameter {
    name: string;
    isPack: boolean;
    defaultType: Type | null;
    defaultTypePack: TypePack | null;
}
interface TypeList {
    types: Type[];
    vararg: TypeVariadic | TypePackReference | null;
}
interface TypeReference extends BaseNode {
    type: 'TypeReference';
    name: string;
    typeArguments: Array<Type | TypePack>;
}
interface TypeUnion extends BaseNode {
    type: 'TypeUnion';
    types: Type[];
}
interface TypeIntersection extends BaseNode {
    type: 'TypeIntersection';
    types: Type[];
}
interface TypeOptional extends BaseNode {
    type: 'TypeOptional';
    base: Type;
}
interface TypeFunction extends BaseNode {
    type: 'TypeFunction';
    generics: GenericTypeParameter[];
    parameters: Array<{
        name: string | null;
        type: Type;
    }>;
    vararg: TypeVariadic | TypePackReference | null;
    returns: TypeList;
}
interface TypeTableField {
    key: string | Type | null;
    value: Type;
    access: 'read' | 'write' | null;
}
interface TypeTable extends BaseNode {
    type: 'TypeTable';
    fields: TypeTableField[];
}
interface TypeLiteralString extends BaseNode {
    type: 'TypeLiteralString';
    value: string;
}
interface TypeLiteralBoolean extends BaseNode {
    type: 'TypeLiteralBoolean';
    value: boolean;
}
interface TypeTypeof extends BaseNode {
    type: 'TypeTypeof';
    expression: Expression;
}
interface TypeParenthesized extends BaseNode {
    type: 'TypeParenthesized';
    type_: Type;
}
interface TypeVariadic extends BaseNode {
    type: 'TypeVariadic';
    base: Type;
}

declare class LexError extends Error {
    line: number;
    column: number;
    constructor(message: string, line: number, column: number);
}

declare class ParseError extends Error {
    line: number;
    column: number;
    constructor(message: string, line: number, column: number);
}

type BindingKind = 'local' | 'parameter' | 'for-loop' | 'for-in' | 'local-function';
interface Binding {
    id: number;
    name: string;
    kind: BindingKind;
    declaration: Identifier;
}
/**
 * Resolves every Identifier's lexical scope in place, mutating the tree.
 * Run this once, right after parsing and before any obfuscation pass reads
 * `.scope` / `.bindingId` — renaming, global-mapping, vmify, etc. all depend
 * on this having already run.
 */
declare function resolveScopes(chunk: Chunk): Chunk;

interface GeneratorOptions {
    /** Emit everything on a single line, statements separated by `;`, instead of pretty-printed/indented. */
    minify?: boolean;
}
declare function generate(chunk: Chunk, options?: GeneratorOptions): string;

type StepConfig = {
    name: 'Vmify';
} | {
    name: 'RenameVariables';
} | {
    name: 'ConstantArray';
} | {
    name: 'EncryptStrings';
} | {
    name: 'EncryptNumbers';
} | {
    name: 'StringsToExpressions';
    min?: number;
    max?: number;
} | {
    name: 'NumbersToExpressions';
    min?: number;
    max?: number;
} | {
    name: 'InsertJunk';
    probability?: number;
    maxPerBlock?: number;
} | {
    name: "GlobalMapping";
    globalTableName?: string;
} | {
    name: "WrapInFunction";
};
interface ObfuscateOptions {
    steps: StepConfig[];
    /** Emit the final output as a single `;`-joined line instead of pretty-printed/indented. Default: false. */
    minify?: boolean;
}

/**
 * Obfuscates Lua/Luau source code by parsing it and running the requested
 * pipeline of passes over the AST, in the order given, then re-emitting
 * source.
 *
 *   obfuscate(src, 'luaU', { steps: [
 *     { name: 'Vmify' },
 *     { name: 'RenameVariables' },
 *     { name: 'ConstantArray' },
 *     { name: 'EncryptStrings' },
 *     { name: 'StringsToExpressions', min: 5, max: 20 },
 *     { name: 'NumbersToExpressions', min: 5, max: 20 },
 *   ]})
 */
declare function obfuscate(source: string, dialect: DialectName, options: ObfuscateOptions): string;

/**
 * Parses source code and returns an AST (Chunk) with lexical scope already
 * resolved: every Identifier's `.scope` ('local' | 'parameter' | 'upvalue' |
 * 'global') and `.bindingId` accurately reflect where it's actually bound,
 * not just the parser's syntactic guess at the declaration site.
 *
 *   parse(source, 'lua5.1')  -> parse as standard Lua 5.1 syntax
 *   parse(source, 'luaU')    -> parse as Luau syntax (types, continue, string interpolation, attributes, etc.)
 *
 * Throws a ParseError when it encounters syntax the dialect doesn't support
 * (e.g. parsing `local x <const> = 1` while the dialect is lua5.1).
 */
declare function parse(source: string, dialect: DialectName): Chunk;

export { type AssignmentStatement, type AssignmentTarget, type Attribute, type BaseNode, type BinaryExpression, type BinaryOperator, type Binding, type BindingKind, type BooleanLiteral, type BreakStatement, type CallExpression, type CallStatement, type Chunk, type CompoundAssignmentStatement, type ContinueStatement, type DialectName, type DoStatement, type ElseClause, type ElseifClause, type Expression, type ForGenericStatement, type ForNumericStatement, type FunctionDeclaration, type FunctionParameter, type GeneratorOptions, type GenericTypeParameter, type GotoStatement, type Identifier, type IfClause, type IfExpression, type IfStatement, type IndexExpression, type InterpolatedStringExpression, type LabelStatement, LexError, type LocalStatement, type LogicalExpression, type MemberExpression, type NilLiteral, type NumericLiteral, type ObfuscateOptions, type ParenthesizedExpression, ParseError, type Position, type RepeatStatement, type ReturnStatement, type SourceLocation, type Statement, type StepConfig, type StringCallExpression, type StringLiteral, type TableCallExpression, type TableConstructorExpression, type TableField, type TableKey, type TableKeyString, type TableValue, type Type, type TypeFunction, type TypeIntersection, type TypeList, type TypeLiteralBoolean, type TypeLiteralString, type TypeOptional, type TypePack, type TypePackExplicit, type TypePackReference, type TypeParenthesized, type TypeReference, type TypeTable, type TypeTableField, type TypeTypeof, type TypeUnion, type TypeVariadic, type UnaryExpression, UnknownDialectError, type VarargLiteral, type WhileStatement, generate, obfuscate, parse, resolveScopes };
