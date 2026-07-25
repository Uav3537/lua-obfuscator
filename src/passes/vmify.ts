// vmify.ts
// Lua 5.1 / Luau VMify — v3
//
// Compiles a chunk into a small custom bytecode format and emits a new
// chunk containing: the constant pool table, the bytecode table, a keyed
// xor helper, and a dispatch-hashed interpreter loop that executes it.
//
// v3 additions over v2:
//   - break / continue, compiled via a per-loop pending-jump-list that's
//     patched once the loop's "next iteration" pc (continue) and "exit" pc
//     (break) are known — same mechanism if/elseif chains already used for
//     their own internal jumps, just tracked per loop frame on a stack so
//     nested loops route break/continue to the innermost enclosing loop.
//   - goto / label. Because this VM already flattens every hoisted local
//     into one persistent register file for the whole chunk (see HOIST),
//     goto/label are compiled the same way: labels are just named pc's in
//     one flat map, gotos are JMPs with a placeholder patched once every
//     statement has been compiled. This is intentionally more permissive
//     than real Lua's goto-scoping rules (can't jump into a local's scope,
//     can't jump into a nested block from outside) — consistent with this
//     file's pre-existing, documented decision to not preserve strict
//     block-scoping semantics anywhere else either.
//   - do...end blocks (pure scoping — hoisted the same way if/while bodies
//     already are, compiled the same way too).
//   - CompoundAssignmentStatement (+=, -=, *=, /=, %=, ^=, ..=). '//=' is
//     rejected (see note at compileCompoundAssignment) since there is no
//     floor-division opcode to desugar it into without silently producing
//     a non-integer result.
//   - generic for (for k, v in iter do ... end), compiled against the
//     standard 3-value iterator protocol (f, s, control), stopping when the
//     first returned value is nil (not merely falsy — false is a valid
//     non-terminal iterator value in real Lua/Luau, so this checks equality
//     against a loaded nil constant rather than truthiness).
//   - multiple return values / multiple assignment from a single call:
//     CALL gained `nret` (how many contiguous result registers to fill)
//     and RETURN gained a value count, so `local a, b = f()` and
//     `return a, b, c` both work now, not just their single-value forms.
//   - varargs (...): the main chunk always captures `...` into a runtime
//     table. `...` used as an ordinary expression yields its first value
//     (VARARG opcode). `...` used as the LAST argument of a call is
//     compiled as a true runtime spread (CALL gained a `spread` flag) so
//     the callee sees however many vararg values actually exist, not a
//     compile-time-fixed count.
//   - IfExpression (Luau's `if c then a else b`, optionally with elseif),
//     compiled as a real branch into the target register, not by eagerly
//     evaluating every arm.
//   - InterpolatedStringExpression (Luau `` `a{expr}b` `` string
//     interpolation), desugared at compile time into a chain of CONCATs.
//   - TypeAlias statements: N/A — the parser now discards Luau type syntax
//     (including `type` aliases) entirely, so no TypeAlias node ever
//     reaches this pass.
//
// v4 additions over v3:
//   - closures / nested function declarations / upvalues. Nested function
//     BODIES are deliberately NOT bytecode-compiled by this pass (only the
//     top-level chunk is) — they're embedded as ordinary, un-vmified Lua
//     AST, so arbitrary nesting depth, self/mutual recursion, and multi-
//     level upvalue chaining all fall out of real Lua's own closure
//     semantics for free instead of needing a hand-rolled reentrant VM +
//     upvalue-chain resolver. The only piece this pass adds is making sure
//     a captured top-level local lives in a shared box (`upvals[i].v`)
//     instead of a plain register, addressed identically from the
//     bytecode (GETUPVAL/SETUPVAL) and from inside the closure itself
//     (baked in directly as `upvals[i].v` at compile time — see the
//     CLOSURES section and computeNeededBoxes/rewriteCapturedRefs). See
//     LIMITATIONS at the bottom for the one case this deliberately still
//     rejects (a closure capturing a for-loop control variable itself,
//     since loop variables don't get a fresh binding per iteration here).

import * as N from '../ast/nodes';
import { parseSnippet } from '../utils/parse-snippet';
import { resolveScopes } from '../analysis/scope';
import { DialectName } from '../dialect';

import {
  ident,
  numLit,
  strLit,
  boolLit,
  nilLit,
  tableCtor,
  tableValue,
  localStmt,
  memberExpr,
  indexExpr,
  returnStmt,
  callExpr
} from '../ast/builders';

import {
  randomVarName,
  randInt,
  shuffle
} from '../utils/random';

import { transformExpressions } from '../utils/walk';

import { Pass, PassContext } from './types';


// ======================================================
// HOIST
// ======================================================
//
// Turns every top-level `local` (plain or function) into a persistent
// register slot, and rewrites the declaration into a plain assignment so
// the rest of the compiler only ever has to deal with AssignmentStatement
// for both cases. Also hoists numeric-for and generic-for loop variables,
// and recurses into do-blocks, since those introduce locals too.

function hoistNamesFromStatement(
  stmt: N.Statement,
  into: N.Identifier[]
): N.Statement {

  if (stmt.type === 'LocalStatement') {

    for (const v of stmt.variables) {

      if (v.type === 'Identifier') {

        into.push({
          ...v,
          attribute: null
        });

      }

    }

    return {
      type: 'AssignmentStatement',
      variables: stmt.variables,
      init: stmt.init,
      range: stmt.range,
      loc: stmt.loc
    } as N.Statement;

  }


  if (
    stmt.type === 'FunctionDeclaration' &&
    stmt.isLocal &&
    stmt.identifier?.type === 'Identifier'
  ) {

    into.push({
      ...stmt.identifier,
      attribute: null
    });


    return {

      type: 'AssignmentStatement',

      variables: [
        stmt.identifier
      ],

      init: [

        // Anonymous function values don't get their own AST node type —
        // per FunctionDeclaration's own doc comment, `identifier: null`
        // IS how an anonymous function/closure literal is represented,
        // both as a statement and (here) as an expression. This used to
        // stamp a fictitious 'FunctionExpression' type that no part of
        // this codebase's AST (or compileExpression's switch) actually
        // recognizes, silently making every `local function` un-compilable
        // as a value — see the CLOSURES section.
        {
          ...stmt,
          type: 'FunctionDeclaration',
          identifier: null,
          isLocal: false
        } as N.FunctionDeclaration

      ],

      range: stmt.range,
      loc: stmt.loc

    } as N.Statement;

  }


  return stmt;

}


// Recursively walk a statement list (including inside if/while/for/repeat/
// do bodies) to hoist every local declared anywhere in the flattened
// chunk. Lua 5.1 / Luau don't have block scoping the way lexical closures
// do here — this VM has a single flat register file for the whole
// compiled chunk, so a `local x` inside an `if` body still needs a
// permanent register that outlives the block (it may be read after the
// if, in nested blocks, or across loop iterations). Callers relying on
// the shadowing/rebinding semantics of two different `local x` in sibling
// blocks are NOT supported — see LIMITATIONS. Each Identifier keeps its
// resolved bindingId (set by resolveScopes upstream) as the hoist key so
// that two genuinely different `x` bindings in disjoint scopes don't
// collide.
function hoistAll(
  stmts: N.Statement[],
  into: N.Identifier[]
): N.Statement[] {

  return stmts.map(s => hoistOne(s, into));

}

function hoistOne(
  stmt: N.Statement,
  into: N.Identifier[]
): N.Statement {

  const rewritten = hoistNamesFromStatement(stmt, into);

  switch (rewritten.type) {

    case 'IfStatement':
      return {
        ...rewritten,
        clauses: rewritten.clauses.map(c => ({
          ...c,
          body: hoistAll(c.body, into)
        }))
      } as N.Statement;

    case 'WhileStatement':
      return {
        ...rewritten,
        body: hoistAll(rewritten.body, into)
      } as N.Statement;

    case 'RepeatStatement':
      return {
        ...rewritten,
        body: hoistAll(rewritten.body, into)
      } as N.Statement;

    case 'ForNumericStatement':
      into.push({ ...rewritten.variable, attribute: null } as N.Identifier);
      return {
        ...rewritten,
        body: hoistAll(rewritten.body, into)
      } as N.Statement;

    case 'ForGenericStatement':
      for (const v of rewritten.variables) {
        if (v.type === 'Identifier') {
          into.push({ ...v, attribute: null } as N.Identifier);
        }
      }
      return {
        ...rewritten,
        body: hoistAll(rewritten.body, into)
      } as N.Statement;

    case 'DoStatement':
      return {
        ...rewritten,
        body: hoistAll(rewritten.body, into)
      } as N.Statement;

    default:
      return rewritten;

  }

}


// ======================================================
// OPCODES
// ======================================================

type OpName =
  | 'MOVE' | 'LOADK'
  | 'GETGLOBAL' | 'SETGLOBAL'
  | 'GETINDEX' | 'SETINDEX'
  | 'NEWTABLE'
  | 'ADD' | 'SUB' | 'MUL' | 'DIV' | 'IDIV' | 'MOD' | 'POW' | 'CONCAT'
  | 'UNM' | 'NOT' | 'LEN'
  | 'EQ' | 'LT' | 'LE'
  | 'JMP' | 'JMPIF' | 'JMPIFNOT'
  | 'CALL' | 'RETURN'
  | 'VARARG' | 'TOSTRING'
  // Closures/upvalues (see the CLOSURES section below). GETUPVAL/SETUPVAL
  // read/write a captured local through its shared box (`upvals[b+1].v`);
  // LOADRAW loads an already-built closure value straight out of the raw
  // (non-keyed) pool — see buildRawPoolDecl.
  | 'GETUPVAL' | 'SETUPVAL' | 'LOADRAW'
  // Table constructors only. Fills in the LAST array-position field when
  // it's `...` or a call — same "only the last position gets true
  // multi-value treatment" rule as call arguments/return lists (see the
  // spreadKind doc on Instr) — everything a preceding fixed field already
  // wrote via SETINDEX is untouched; these just append starting at `b`.
  | 'SPREADVARARG' | 'SPREADMULTRET'
  | 'NOP' | 'XOR';

const OPCODE_NAMES: OpName[] = [
  'MOVE', 'LOADK',
  'GETGLOBAL', 'SETGLOBAL',
  'GETINDEX', 'SETINDEX',
  'NEWTABLE',
  'ADD', 'SUB', 'MUL', 'DIV', 'IDIV', 'MOD', 'POW', 'CONCAT',
  'UNM', 'NOT', 'LEN',
  'EQ', 'LT', 'LE',
  'JMP', 'JMPIF', 'JMPIFNOT',
  'CALL', 'RETURN',
  'VARARG', 'TOSTRING',
  'GETUPVAL', 'SETUPVAL', 'LOADRAW',
  'SPREADVARARG', 'SPREADMULTRET',
  'NOP', 'XOR'
];

function buildShuffledOpcodes(): Record<OpName, number> {

  const shuffled = shuffle(OPCODE_NAMES);

  const map = {} as Record<OpName, number>;

  shuffled.forEach((name, i) => {
    map[name] = i + 1;
  });

  return map;

}


interface Instr {
  op: number;
  a: number;
  b: number;
  c: number;
  // CALL only: registers b..b+nargs-1 hold the (fixed) arguments (b itself
  // is the function). Also doubles as RETURN's value count (how many
  // consecutive registers starting at 0 to return).
  nargs?: number;
  // CALL only: how many consecutive result registers starting at `a` to
  // fill from the call's return values. Defaults to 1 at decode time if
  // omitted.
  nret?: number;
  // CALL/RETURN: 0 = no spread, the fixed `nargs` values are everything.
  // 1 = `...` spread — all runtime vararg values are appended after the
  // fixed `nargs` values (compiles `f(a, ...)` / `return a, ...`).
  // 2 = multret spread — all values from the MOST RECENTLY captured call
  // (see `captureMultret` below) are appended instead. This is how a
  // plain call (not `...`) in the LAST position of an argument list or
  // return list expands to ALL of its return values, matching real Lua's
  // "only the last expression in a list expands" rule — e.g. `f(a, g())`
  // passes every value g() returns, and `return a, g()` returns every
  // value g() returns, not just the first of each.
  spreadKind?: 0 | 1 | 2;
  // CALL only: if true, this call's FULL return-value array is stashed
  // into the runtime's shared multret buffer (see buildRuntimeSource's
  // `mrName`) in addition to filling `nret` registers as normal. Always
  // paired with a spreadKind:2 CALL/RETURN emitted immediately after —
  // see compileCallIntoWithCapture.
  captureMultret?: boolean;
}


// ======================================================
// CONSTANT POOL
// ======================================================

type PoolValue = number | string | boolean | null;

class ConstantPool {

  values: PoolValue[] = [];
  map = new Map<string, number>();

  add(v: PoolValue): number {

    const key = typeof v + ':' + String(v);
    const old = this.map.get(key);
    if (old !== undefined) return old;

    const id = this.values.length;
    this.values.push(v);
    this.map.set(key, id);
    return id;

  }

}


function constNodeFor(v: PoolValue): N.Expression {

  if (v === null) return nilLit();

  switch (typeof v) {
    case 'number': return numLit(v);
    case 'string': return strLit(v);
    case 'boolean': return boolLit(v);
    default:
      throw new Error(`VMify: unsupported constant type in pool: ${typeof v}`);
  }

}


// ======================================================
// REGISTER ALLOCATOR
// ======================================================
//
// Hoisted locals permanently occupy registers 0..regs.size-1 for the
// whole chunk; every statement resets the temp cursor back to regs.size
// before compiling, so sub-expression temps never alias a live local.
// Loops re-run the *same* statement compiler on every iteration at
// runtime (the bytecode itself is emitted once, executed repeatedly), so
// this reset-per-statement discipline is what keeps a loop body's temp
// usage bounded instead of growing every pass.

class RegisterAllocator {

  private next = 0;

  alloc(): number {
    const r = this.next;
    this.next++;
    return r;
  }

  reset(base = 0) {
    this.next = base;
  }

  high(): number {
    return this.next;
  }

}


// ======================================================
// COMPILE STATE
// ======================================================

interface LoopFrame {
  // pc's of JMP placeholders emitted by `continue` inside this loop,
  // patched once the loop's "next iteration" pc is known.
  continueJumps: number[];
  // pc's of JMP placeholders emitted by `break` inside this loop, patched
  // once the loop's exit pc is known.
  breakJumps: number[];
}

interface CompileState {
  pool: ConstantPool;
  // Keyed by bindingId (from resolveScopes), NOT by name — two disjoint
  // `local x` in sibling scopes get distinct bindingIds and therefore
  // distinct registers/boxes now, instead of colliding on the shared name
  // "x" the way this used to work. See the HOIST section.
  regs: Map<number, number>;
  // bindingId -> index into the shared `upvals` array (see CLOSURES below)
  // for every top-level local/param that some nested closure captures.
  // Disjoint from `regs`: a binding is in exactly one of the two maps.
  boxIndex: Map<number, number>;
  // Closure literals compiled so far this chunk, in emission order —
  // LOADRAW's `b` operand is a plain (non-keyed) index into this list.
  // Populated by compileClosureLiteral, consumed by buildRawPoolDecl.
  rawPool: N.Expression[];
  // Chosen once, up front (unlike the other generated names below, which
  // are only needed after compilation finishes) because compileClosureLiteral
  // must bake this name as a literal identifier into embedded closure
  // source *during* compilation — see rewriteCapturedRefs.
  upvalsName: string;
  allocator: RegisterAllocator;
  // The lowest register index that is currently "safe" to reset the
  // allocator to. Equal to regs.size outside of any loop. A numeric-for or
  // generic-for loop raises this for the duration of compiling its body,
  // because those loops keep extra control registers alive across the
  // whole loop (limitReg/stepReg, or f/s/ctrl) that live just above
  // regs.size but are NOT tracked in regs.size itself. Every statement/
  // expression compiler that wants to reuse scratch registers MUST reset
  // through this field (not through a hardcoded regs.size), or it will
  // clobber those live loop-control registers — see the vmify bugfix note
  // in vmify.ts's file header for the incident this was added to fix.
  regFloor: number;
  opcodes: Record<OpName, number>;
  // Per-instruction rotating key stream (see buildKeyStream). encodeKey(pc)
  // returns the key instruction pc was encoded with; both the const-pool
  // xor and the opcode xor for a given instruction reuse the same
  // per-instruction key, so the runtime only needs one keystream function,
  // not two independent ones.
  keySeed: number;
  code: Instr[];
  // Stack of enclosing loops, innermost last. break/continue always
  // target loopStack[loopStack.length - 1].
  loopStack: LoopFrame[];
  // name -> pc, populated as LabelStatements are compiled. Flat across the
  // whole chunk (see the goto/label note in the file header).
  labels: Map<string, number>;
  // Placeholder JMPs emitted by GotoStatement, resolved against `labels`
  // once every statement in the chunk has been compiled (a goto may
  // legally jump forward to a label that hasn't been compiled yet).
  pendingGotos: { name: string; pc: number }[];
  // Every distinct name that GETGLOBAL/SETGLOBAL reads or writes over the
  // whole chunk. Used after compilation to build a local reference table
  // (see buildEnvDecl) that the runtime indexes instead of `_G` — `_G` is
  // NOT the real global environment in every host (Roblox/Luau's `_G` is
  // just an empty shared user table, not getfenv()), so resolving globals
  // through `_G` silently returns nil for real builtins like `print`.
  usedGlobals: Set<string>;
}


// A tiny LCG used both at compile time (to know which key a given pc was
// encoded with) and reproduced in the emitted Lua runtime (see
// buildRuntimeSource) so the interpreter can regenerate the same stream
// without shipping it as data. Parameters are the classic Numerical
// Recipes constants; this is an obfuscation speed bump, not cryptography.
function keyAt(seed: number, pc: number): number {
  let x = (seed + pc * 2654435761) >>> 0;
  x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
  return (x % 251) + 1; // 1..251, never 0 so xor is never a no-op
}


// ======================================================
// EXPRESSION COMPILER
// ======================================================

// Constants (LOADK's b operand, and GETGLOBAL/SETGLOBAL's name operand)
// are xor'd with keyAt(pc) at the pc they're emitted at — but `pc` here
// means "index in the final instruction array", so callers MUST push each
// instruction the moment they build it (state.code.push(...)) rather than
// building an array on the side and splicing it in later, or the pc used
// for keying won't match the pc it ends up at. Every function below
// follows that push-immediately discipline.

function push(state: CompileState, instr: Instr): number {
  const pc = state.code.length;
  state.code.push(instr);
  return pc;
}

function keyedConst(state: CompileState, pcForKey: number, v: PoolValue | string): number {
  const k = keyAt(state.keySeed, pcForKey);
  return state.pool.add(v as PoolValue) ^ k;
}

// Same as keyedConst, but ALSO records `name` in state.usedGlobals. Every
// GETGLOBAL/SETGLOBAL emission site must go through this (not the plain
// keyedConst above) so the post-compile ENV table (buildEnvDecl) knows
// every name it needs to capture a real reference to.
function keyedGlobalConst(state: CompileState, pcForKey: number, name: string): number {
  state.usedGlobals.add(name);
  return keyedConst(state, pcForKey, name);
}


// Shared by every read site (Identifier expression, MemberExpression base,
// etc. all funnel through compileExpression's Identifier case). Returns
// true if `id` resolved to a local register or a captured box (and
// emitted the instruction to fetch it into `target`); false means the
// caller should fall back to a global lookup.
function readVarInto(id: N.Identifier, state: CompileState, target: number): boolean {

  const bid = id.bindingId;
  if (bid == null) return false;

  const reg = state.regs.get(bid);
  if (reg !== undefined) {
    state.code.push({ op: state.opcodes.MOVE, a: target, b: reg, c: 0 });
    return true;
  }

  const box = state.boxIndex.get(bid);
  if (box !== undefined) {
    state.code.push({ op: state.opcodes.GETUPVAL, a: target, b: box, c: 0 });
    return true;
  }

  return false;

}

// Shared by every write site (plain assignment, compound assignment).
// Returns true if `id` resolved to a local register or a captured box
// (and emitted the instruction to store `srcReg` into it); false means
// the caller should fall back to a global store.
function writeVarFrom(id: N.Identifier, state: CompileState, srcReg: number): boolean {

  const bid = id.bindingId;
  if (bid == null) return false;

  const reg = state.regs.get(bid);
  if (reg !== undefined) {
    state.code.push({ op: state.opcodes.MOVE, a: reg, b: srcReg, c: 0 });
    return true;
  }

  const box = state.boxIndex.get(bid);
  if (box !== undefined) {
    state.code.push({ op: state.opcodes.SETUPVAL, a: box, b: srcReg, c: 0 });
    return true;
  }

  return false;

}


// ======================================================
// CLOSURES
// ======================================================
//
// Nested function bodies are NOT bytecode-compiled by this pass at all —
// they're left as ordinary, un-vmified Lua AST (only the top-level chunk
// gets flattened into registers/bytecode). A closure literal compiles to
// a single LOADRAW pulling an already-built Lua function value out of a
// raw (non-keyed) pool built once, up front, alongside the regular
// constant pool.
//
// This works because real Lua closures do all the hard work for free:
// every top-level local/param that ANY nested function captures (found by
// computeNeededBoxes, scanning resolveScopes' `scope === 'upvalue'`
// marks) is put in a shared box (`{v = <value>}`) living in the ONE
// `upvals` array declared once at chunk start, instead of a plain
// register. Every reference to that binding — from the bytecode itself
// (GETUPVAL/SETUPVAL) *and* from inside any closure, however deeply
// nested — addresses the exact same `upvals[i].v` by the same fixed
// index, so mutations are visible everywhere, and chaining across
// multiple levels of nested closures needs no extra bookkeeping: a
// doubly-nested closure just references `upvals[i].v` directly too, the
// same as its parent would, since `upvals` is an ordinary Lua local
// enclosing every nesting level lexically.
//
// The one real gap (see the compileForNumeric/compileForGeneric checks
// above): this VM hoists every local — including loop control variables —
// to ONE persistent slot for the whole chunk rather than a fresh one per
// iteration, so a closure capturing a *for-loop variable itself* would
// see a stale/shared value instead of its own. That specific case is
// rejected at compile time with a clear error rather than silently
// mis-compiled; capturing an ordinary local/param (including a local
// copy of a loop variable made inside the loop body) works correctly.

// Walks `body` (a pre-HOIST statement list) collecting the bindingId of
// every Identifier referenced with scope 'upvalue' — i.e. every binding
// declared outside the function that references it. Since this pass only
// ever bytecode-compiles the top-level chunk, every such bindingId must
// name a top-level local/param, which is exactly what needs a box.
function computeNeededBoxes(body: N.Statement[]): Set<number> {

  const needed = new Set<number>();
  const wrapper: N.Chunk = { type: 'Chunk', body, range: [0, 0], loc: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } };

  transformExpressions(wrapper, (expr) => {
    if (expr.type === 'Identifier' && !expr.isField && expr.scope === 'upvalue' && expr.bindingId != null) {
      needed.add(expr.bindingId);
    }
    return expr;
  });

  return needed;

}

// Deep-clones `fn` and rewrites every reference to a boxed top-level
// binding (found via state.boxIndex) into `upvals[i].v` — descends into
// arbitrarily-nested function bodies too (transformExpressions already
// does that), so multi-level nesting "just works" without separate
// per-level capture threading. Everything else (the closure's own
// params/locals, globals, and any binding that isn't boxed) is left
// completely alone.
function rewriteCapturedRefs(fn: N.FunctionDeclaration, state: CompileState): N.FunctionDeclaration {

  const cloned = structuredClone(fn);
  const wrapper: N.Chunk = { type: 'Chunk', body: [returnStmt([cloned])], range: [0, 0], loc: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } };

  transformExpressions(wrapper, (expr) => {
    if (expr.type !== 'Identifier' || expr.isField || expr.bindingId == null) return expr;
    const box = state.boxIndex.get(expr.bindingId);
    if (box === undefined) return expr;
    // upvals[box + 1].v — box is a compile-time-known constant, baked
    // directly into the embedded closure's own source.
    return memberExpr(indexExpr(ident(state.upvalsName), numLit(box + 1)), 'v');
  });

  return (wrapper.body[0] as N.ReturnStatement).arguments[0] as N.FunctionDeclaration;

}

// Compiles a closure literal (anonymous FunctionDeclaration used as an
// expression) into the raw pool and returns its index for LOADRAW.
function compileClosureLiteral(fn: N.FunctionDeclaration, state: CompileState): number {

  const rewritten = rewriteCapturedRefs(fn, state);
  const idx = state.rawPool.length;
  state.rawPool.push(rewritten);
  return idx;

}


function compileExpression(
  expr: N.Expression,
  state: CompileState,
  target: number
): void {

  if (!expr) return;

  switch (expr.type) {

    case 'NilLiteral': {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: target, b: keyedConst(state, pc, null), c: 0 });
      return;
    }

    case 'NumericLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral': {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: target, b: keyedConst(state, pc, expr.value), c: 0 });
      return;
    }

    case 'VarargLiteral': {
      // Yields the FIRST vararg value only. A true multi-value spread is
      // only supported as the last argument of a call — see
      // compileCallInto's `spreadLast` handling.
      state.code.push({ op: state.opcodes.VARARG, a: target, b: 0, c: 0 });
      return;
    }

    case 'Identifier': {

      if (readVarInto(expr, state, target)) return;

      const pc = state.code.length;
      state.code.push({ op: state.opcodes.GETGLOBAL, a: target, b: keyedGlobalConst(state, pc, expr.name), c: 0 });
      return;

    }

    case 'FunctionDeclaration': {
      // Anonymous function literal used as a value (`local f = function()
      // ... end`, or a `local function` after HOIST rewrote it into an
      // assignment — see hoistNamesFromStatement). See the CLOSURES
      // section for how this compiles.
      const rawIdx = compileClosureLiteral(expr, state);
      state.code.push({ op: state.opcodes.LOADRAW, a: target, b: rawIdx, c: 0 });
      return;
    }

    case 'MemberExpression': {

      // t.k sugar — compiled identically to t['k'].
      const baseReg = state.allocator.alloc();
      compileExpression(expr.base, state, baseReg);

      const keyReg = state.allocator.alloc();
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: keyReg, b: keyedConst(state, pc, expr.identifier.name), c: 0 });

      state.code.push({ op: state.opcodes.GETINDEX, a: target, b: baseReg, c: keyReg });
      return;

    }

    case 'IndexExpression': {

      const baseReg = state.allocator.alloc();
      compileExpression(expr.base, state, baseReg);

      const keyReg = state.allocator.alloc();
      compileExpression(expr.index, state, keyReg);

      state.code.push({ op: state.opcodes.GETINDEX, a: target, b: baseReg, c: keyReg });
      return;

    }

    case 'UnaryExpression': {

      const src = state.allocator.alloc();
      compileExpression(expr.argument, state, src);

      const operator = expr.operator;

      let op: number;
      switch (operator) {
        case '-': op = state.opcodes.UNM; break;
        case 'not': op = state.opcodes.NOT; break;
        case '#': op = state.opcodes.LEN; break;
        default:
          throw new Error(`VMify: unsupported unary operator '${operator}'`);
      }

      state.code.push({ op, a: target, b: src, c: 0 });
      return;

    }

    case 'LogicalExpression': {

      // Short-circuit: `a and b` -> eval a into target; if target is
      // falsy, skip b (target already holds a's falsy value, which is
      // exactly the Lua result). `a or b` -> eval a into target; if
      // target is truthy, skip b. Compiled as real jumps (not a helper
      // instruction) specifically so side effects in `b` don't execute on
      // the short-circuited path.
      compileExpression(expr.left, state, target);

      const testOp = expr.operator === 'and'
        ? state.opcodes.JMPIFNOT
        : state.opcodes.JMPIF;

      const jmpPc = push(state, { op: testOp, a: target, b: -1, c: 0 });

      compileExpression(expr.right, state, target);

      patchJumpTarget(state, jmpPc, state.code.length);
      return;

    }

    case 'BinaryExpression': {

      const left = state.allocator.alloc();
      compileExpression(expr.left, state, left);

      const right = state.allocator.alloc();
      compileExpression(expr.right, state, right);

      let op: number;
      let swapForGt = false;

      switch (expr.operator) {
        case '+': op = state.opcodes.ADD; break;
        case '-': op = state.opcodes.SUB; break;
        case '*': op = state.opcodes.MUL; break;
        case '/': op = state.opcodes.DIV; break;
        case '%': op = state.opcodes.MOD; break;
        case '^': op = state.opcodes.POW; break;
        case '..': op = state.opcodes.CONCAT; break;
        case '==': op = state.opcodes.EQ; break;
        case '<': op = state.opcodes.LT; break;
        case '<=': op = state.opcodes.LE; break;
        // ~=, >, >= are all expressed via EQ/LT/LE: `a ~= b` is `not (a ==
        // b)`, and `a > b` / `a >= b` are `b < a` / `b <= a` with operands
        // swapped, so the instruction set doesn't need four more opcodes.
        case '~=': op = state.opcodes.EQ; break;
        case '>': op = state.opcodes.LT; swapForGt = true; break;
        case '>=': op = state.opcodes.LE; swapForGt = true; break;
        case '//': op = state.opcodes.IDIV; break;
        default:
          throw new Error(`VMify: unsupported binary operator '${expr.operator}'`);
      }

      const a = swapForGt ? right : left;
      const b = swapForGt ? left : right;

      state.code.push({ op, a: target, b: a, c: b });

      if (expr.operator === '~=') {
        state.code.push({ op: state.opcodes.NOT, a: target, b: target, c: 0 });
      }

      return;

    }

    case 'IfExpression': {

      // Luau `if c1 then e1 elseif c2 then e2 else e3` as a value. Compiled
      // as a real branch into `target` (not by evaluating every arm and
      // picking one), same shape as compileIf but expression-flavored: the
      // last clause always has condition === null (the mandatory else).
      const endJumps: number[] = [];

      for (let i = 0; i < expr.clauses.length; i++) {

        const clause = expr.clauses[i];
        const isLast = clause.condition === null;

        let skipPc = -1;

        if (!isLast) {
          const condReg = state.allocator.alloc();
          compileExpression(clause.condition as N.Expression, state, condReg);
          skipPc = push(state, { op: state.opcodes.JMPIFNOT, a: condReg, b: -1, c: 0 });
        }

        compileExpression(clause.body, state, target);

        if (!isLast) {
          endJumps.push(push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 }));
          patchJumpTarget(state, skipPc, state.code.length);
        }

      }

      const endPc = state.code.length;
      for (const j of endJumps) {
        patchJumpTarget(state, j, endPc);
      }

      return;

    }

    case 'InterpolatedStringExpression': {

      // `a{expr1}b{expr2}c` -> chain of CONCATs built left to right. Every
      // interpolated value is routed through TOSTRING first — matching
      // real Luau interpolation semantics, which calls tostring() on each
      // interpolated value (so booleans/nil/tables stringify instead of
      // raising a runtime error the way bare `..` would).
      const { strings, expressions } = expr;
      let haveValue = false;

      for (let i = 0; i < strings.length; i++) {

        if (strings[i].length > 0 || i === 0) {
          if (!haveValue) {
            const pc = state.code.length;
            state.code.push({ op: state.opcodes.LOADK, a: target, b: keyedConst(state, pc, strings[i]), c: 0 });
            haveValue = true;
          } else {
            const piece = state.allocator.alloc();
            const pc = state.code.length;
            state.code.push({ op: state.opcodes.LOADK, a: piece, b: keyedConst(state, pc, strings[i]), c: 0 });
            state.code.push({ op: state.opcodes.CONCAT, a: target, b: target, c: piece });
          }
        }

        if (i < expressions.length) {
          const raw = state.allocator.alloc();
          compileExpression(expressions[i], state, raw);

          if (!haveValue) {
            state.code.push({ op: state.opcodes.TOSTRING, a: target, b: raw, c: 0 });
            haveValue = true;
          } else {
            const piece = state.allocator.alloc();
            state.code.push({ op: state.opcodes.TOSTRING, a: piece, b: raw, c: 0 });
            state.code.push({ op: state.opcodes.CONCAT, a: target, b: target, c: piece });
          }
        }

      }

      if (!haveValue) {
        const pc = state.code.length;
        state.code.push({ op: state.opcodes.LOADK, a: target, b: keyedConst(state, pc, ''), c: 0 });
      }

      return;

    }

    case 'TableConstructorExpression': {

      state.code.push({ op: state.opcodes.NEWTABLE, a: target, b: 0, c: 0 });

      let arrayIndex = 1;

      expr.fields.forEach((field, i) => {

        const isLast = i === expr.fields.length - 1;

        if (field.type === 'TableValue') {

          // Only the LAST field, if it's `...` or a call, gets true
          // multi-value expansion — same "only the last position
          // expands" rule as everywhere else in this compiler (call
          // args, return lists, multi-assignment).
          if (isLast && field.value.type === 'VarargLiteral') {
            state.code.push({ op: state.opcodes.SPREADVARARG, a: target, b: arrayIndex, c: 0 });
            return;
          }

          if (isLast && field.value.type === 'CallExpression') {
            const scratch = state.allocator.alloc();
            compileCallIntoWithCapture(field.value, state, scratch);
            state.code.push({ op: state.opcodes.SPREADMULTRET, a: target, b: arrayIndex, c: 0 });
            return;
          }

          const valReg = state.allocator.alloc();
          compileExpression(field.value, state, valReg);
          const keyReg = state.allocator.alloc();
          const pc = state.code.length;
          state.code.push({ op: state.opcodes.LOADK, a: keyReg, b: keyedConst(state, pc, arrayIndex), c: 0 });
          state.code.push({ op: state.opcodes.SETINDEX, a: target, b: keyReg, c: valReg });
          arrayIndex++;
          return;

        }

        if (field.type === 'TableKeyString') {
          const valReg = state.allocator.alloc();
          compileExpression(field.value, state, valReg);
          const keyReg = state.allocator.alloc();
          const pc = state.code.length;
          state.code.push({ op: state.opcodes.LOADK, a: keyReg, b: keyedConst(state, pc, field.key.name), c: 0 });
          state.code.push({ op: state.opcodes.SETINDEX, a: target, b: keyReg, c: valReg });
          return;
        }

        // TableKey: { [expr] = expr }
        const keyReg = state.allocator.alloc();
        compileExpression(field.key, state, keyReg);
        const valReg = state.allocator.alloc();
        compileExpression(field.value, state, valReg);
        state.code.push({ op: state.opcodes.SETINDEX, a: target, b: keyReg, c: valReg });

      });

      return;

    }

    case 'CallExpression': {
      compileCallInto(expr, state, target);
      return;
    }

    case 'TableCallExpression': {
      // `foo{...}` sugar — identical to `foo({...})`, just without the
      // parens in the source.
      compileCallInto(callExpr(expr.base, [expr.arguments[0]]), state, target);
      return;
    }

    case 'StringCallExpression': {
      // `foo"str"` sugar — identical to `foo("str")`.
      compileCallInto(callExpr(expr.base, [expr.argument]), state, target);
      return;
    }

    case 'ParenthesizedExpression': {
      // `(expr)` — parens only affect parsing (e.g. truncating a call's
      // multi-value expansion to one value) and precedence, never the
      // compiled value itself, so just compile the inner expression
      // straight into the same target register.
      compileExpression(expr.expression, state, target);
      return;
    }

  }

  throw new Error(
    `VMify: unsupported expression type '${(expr as N.Expression).type}' ` +
    '(only ParenthesizedExpression was missing — see the case added above; ' +
    'anything else here is a genuinely new gap, not the closures/upvalues work)'
  );

}


// Shared by CallStatement and CallExpression-as-value. Arguments are
// evaluated into a contiguous register run starting right after the
// function register, matching how CALL's `nargs` addresses them.
//
// `nret` controls how many consecutive registers starting at `target` get
// filled with the call's return values (defaults to 1 — the common case
// of using a call as a single-value expression). Callers that need
// multiple return values (`local a, b = f()`, `for k,v in iter() do`)
// pass a larger nret and are responsible for target..target+nret-1 being
// safe to overwrite.
//
// If the LAST argument in the call is `...`, it's compiled as a true
// runtime spread (CALL's `spread` flag) instead of being evaluated as an
// ordinary single-value expression — `...` anywhere else in the argument
// list (not last) still only contributes its first value, same as real
// Lua's "only the last expression in a list expands" rule.
function compileCallInto(
  call: N.CallExpression,
  state: CompileState,
  target: number,
  nret: number = 1
): void {

  // No whitelist here anymore — any expression compileExpression itself
  // can produce a value for is fair game as a call target (t[k](), t.k(),
  // (expr)(), IIFEs, chained calls, etc). If compileExpression truly can't
  // compile some expression type, it throws its own clear error there;
  // duplicating a second, narrower whitelist up here just meant real,
  // valid call shapes (t[k](...), parenthesized bases, ...) kept getting
  // rejected one at a time as they turned up in practice.
  let unwrappedBase: N.Expression = call.base;
  while (unwrappedBase.type === 'ParenthesizedExpression') {
    unwrappedBase = unwrappedBase.expression;
  }

  // `obj:method(args)` is real Lua's sugar for `obj.method(obj, args)` —
  // the object gets implicitly passed as the first argument. That sugar
  // only works because Lua's own `:` syntax stays intact all the way to
  // execution; this VM instead lowers every call straight down to
  // "get the function value, then call it with these registers" bytecode,
  // so nothing implicitly passes `self` unless we do it ourselves here.
  // Missing this is a silent, non-throwing miscompile: `obj:method(args)`
  // still "compiles" and still calls the right function, just without its
  // receiver — e.g. `game:GetService("Workspace")` would actually invoke
  // GetService("Workspace") with `self` missing entirely, corrupting
  // every parameter's position by one.
  const isMethodCall = unwrappedBase.type === 'MemberExpression' && unwrappedBase.indexer === ':';

  let func: number;
  let selfReg: number | undefined;

  if (isMethodCall) {
    const memberBase = unwrappedBase as N.MemberExpression;
    selfReg = state.allocator.alloc();
    compileExpression(memberBase.base, state, selfReg);

    const keyReg = state.allocator.alloc();
    const pc = state.code.length;
    state.code.push({ op: state.opcodes.LOADK, a: keyReg, b: keyedConst(state, pc, memberBase.identifier.name), c: 0 });

    func = state.allocator.alloc();
    state.code.push({ op: state.opcodes.GETINDEX, a: func, b: selfReg, c: keyReg });
  } else {
    func = state.allocator.alloc();
    // Pass the ORIGINAL call.base (still possibly parenthesized), not
    // unwrappedBase — compileExpression's own ParenthesizedExpression
    // case already unwraps it correctly.
    compileExpression(call.base, state, func);
  }

  const lastArg = call.arguments[call.arguments.length - 1];
  const varargSpread = call.arguments.length > 0 && lastArg.type === 'VarargLiteral';
  // A plain call (not `...`) in the LAST argument position ALSO expands to
  // every value it returns in real Lua/Luau — e.g. `f(a, g())` passes
  // however many values g() actually returns, not just its first. Only the
  // LAST position gets this treatment; a call anywhere else in the
  // argument list still only contributes its first value (unchanged,
  // matches real Lua's "only the last expression in a list expands" rule).
  const callSpread = !varargSpread && call.arguments.length > 0 && lastArg.type === 'CallExpression';
  const fixedArgs = (varargSpread || callSpread) ? call.arguments.slice(0, -1) : call.arguments;

  let argBase: number;

  // `self` (if this is a method call) always occupies argument slot 0,
  // ahead of every explicit argument — same position Lua's `:` sugar puts
  // it in.
  if (selfReg === undefined && fixedArgs.length === 0) {
    argBase = state.allocator.alloc();
  } else {
    // Compile each fixed argument into its own freshly-allocated scratch
    // register FIRST (in order, for correct left-to-right side-effect
    // evaluation), THEN fan them out into a contiguous run via MOVE.
    // Compiling straight into a pre-reserved contiguous slot doesn't
    // work in general: an argument that needs its own internal scratch
    // to compute (a BinaryExpression, a nested call, a table
    // constructor, ...) bumps the allocator past "the next slot in the
    // contiguous run" before the NEXT argument gets its turn, which
    // used to desync the run and trip the "non-contiguous" check below
    // for anything past the first non-trivial argument.
    const argScratch: number[] = selfReg !== undefined ? [selfReg] : [];
    for (const argExpr of fixedArgs) {
      const r = state.allocator.alloc();
      compileExpression(argExpr, state, r);
      argScratch.push(r);
    }

    argBase = state.allocator.alloc();
    for (let i = 1; i < argScratch.length; i++) state.allocator.alloc();

    argScratch.forEach((r, i) => {
      state.code.push({ op: state.opcodes.MOVE, a: argBase + i, b: r, c: 0 });
    });
  }

  let spreadKind: 0 | 1 | 2 = 0;
  if (varargSpread) {
    spreadKind = 1;
  } else if (callSpread) {
    // Compile the trailing call BEFORE emitting this outer CALL, into a
    // throwaway scratch register — we don't want its single first value,
    // we want ALL of its return values, which compileCallIntoWithCapture
    // stashes into the runtime's shared multret buffer for this CALL to
    // splice in as trailing arguments (spreadKind 2).
    const scratch = state.allocator.alloc();
    compileCallIntoWithCapture(lastArg as N.CallExpression, state, scratch);
    spreadKind = 2;
  }

  state.code.push({
    op: state.opcodes.CALL,
    a: target,
    b: func,
    c: argBase,
    nargs: (selfReg !== undefined ? 1 : 0) + fixedArgs.length,
    nret,
    spreadKind
  });

}

// Identical to compileCallInto, but also marks the CALL it emits to stash
// its FULL return-value array into the runtime's shared multret buffer
// (see the `mrName` local in buildRuntimeSource). Used whenever a call
// sits in a position that needs ALL of its return values rather than
// just one — the last argument of another call, or the last expression of
// a return statement.
function compileCallIntoWithCapture(
  call: N.CallExpression,
  state: CompileState,
  target: number
): void {
  compileCallInto(call, state, target, 1);
  state.code[state.code.length - 1].captureMultret = true;
}


// ======================================================
// JUMP PATCHING
// ======================================================
//
// Jumps are emitted with a placeholder target (-1) and patched once the
// real destination pc is known. `b` carries the destination pc directly
// (not a relative offset) — simpler to reason about at the cost of a
// slightly bigger encoded range, and this VM's programs are small enough
// that this is not a real constraint.

function patchJumpTarget(state: CompileState, jmpPc: number, destPc: number): void {

  const instr = state.code[jmpPc];
  const k = keyAt(state.keySeed, jmpPc);
  instr.b = destPc ^ k;

}


// ======================================================
// STATEMENT COMPILER
// ======================================================

function writeAssignTarget(v: N.AssignmentTarget, srcReg: number, state: CompileState): void {

  if (v.type === 'Identifier') {
    if (writeVarFrom(v, state, srcReg)) return;
    const pc = state.code.length;
    state.code.push({ op: state.opcodes.SETGLOBAL, a: srcReg, b: keyedGlobalConst(state, pc, v.name), c: 0 });
    return;
  }

  if (v.type === 'MemberExpression' || v.type === 'IndexExpression') {
    const baseReg = state.allocator.alloc();
    compileExpression(v.base, state, baseReg);
    const keyReg = state.allocator.alloc();
    if (v.type === 'MemberExpression') {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: keyReg, b: keyedConst(state, pc, v.identifier.name), c: 0 });
    } else {
      compileExpression(v.index, state, keyReg);
    }
    state.code.push({ op: state.opcodes.SETINDEX, a: baseReg, b: keyReg, c: srcReg });
    return;
  }

  throw new Error(
    `VMify: unsupported assignment target '${(v as N.Expression).type}' ` +
    '(only identifiers and t.k / t[k] are supported)'
  );

}


// Compiles a single `variable = expr` pair (expr may be undefined, meaning
// "no initializer, assign nil" — used when there are more variables than
// init expressions). Shared by both branches of compileAssignment below.
function compileSingleInit(v: N.AssignmentTarget, expr: N.Expression | undefined, state: CompileState): void {

  if (v.type === 'Identifier') {

    const bid = v.bindingId;
    const local = bid != null ? state.regs.get(bid) : undefined;

    if (local !== undefined) {

      if (expr) {
        compileExpression(expr, state, local);
      } else {
        const pc = state.code.length;
        state.code.push({ op: state.opcodes.LOADK, a: local, b: keyedConst(state, pc, null), c: 0 });
      }

      return;

    }

    const box = bid != null ? state.boxIndex.get(bid) : undefined;

    if (box !== undefined) {

      const temp = state.allocator.alloc();

      if (expr) {
        compileExpression(expr, state, temp);
      } else {
        const pc = state.code.length;
        state.code.push({ op: state.opcodes.LOADK, a: temp, b: keyedConst(state, pc, null), c: 0 });
      }

      state.code.push({ op: state.opcodes.SETUPVAL, a: box, b: temp, c: 0 });
      return;

    }

    {

      const temp = state.allocator.alloc();

      if (expr) {
        compileExpression(expr, state, temp);
      } else {
        const pc = state.code.length;
        state.code.push({ op: state.opcodes.LOADK, a: temp, b: keyedConst(state, pc, null), c: 0 });
      }

      const pc2 = state.code.length;
      state.code.push({ op: state.opcodes.SETGLOBAL, a: temp, b: keyedGlobalConst(state, pc2, v.name), c: 0 });

    }

    return;

  }

  if (v.type === 'MemberExpression' || v.type === 'IndexExpression') {

    const baseReg = state.allocator.alloc();
    compileExpression(v.base, state, baseReg);

    const keyReg = state.allocator.alloc();

    if (v.type === 'MemberExpression') {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: keyReg, b: keyedConst(state, pc, v.identifier.name), c: 0 });
    } else {
      compileExpression(v.index, state, keyReg);
    }

    const valReg = state.allocator.alloc();
    if (expr) {
      compileExpression(expr, state, valReg);
    } else {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: valReg, b: keyedConst(state, pc, null), c: 0 });
    }

    state.code.push({ op: state.opcodes.SETINDEX, a: baseReg, b: keyReg, c: valReg });
    return;

  }

  throw new Error(
    `VMify: unsupported assignment target '${(v as N.Expression).type}' ` +
    '(only identifiers and t.k / t[k] are supported)'
  );

}


function compileAssignment(stmt: N.AssignmentStatement, state: CompileState): void {

  const nInit = stmt.init.length;
  const nVars = stmt.variables.length;

  // `local a, b, c = x, f()` / `a, b, c = f()` — real Lua's rule is that
  // only the LAST expression in the init list expands to fill however
  // many variable slots remain; everything before it contributes exactly
  // one value each, same as compileSingleInit already does below. This
  // only needs special handling when the last init is a CallExpression AND
  // there are MORE variables than init expressions (i.e. that trailing
  // call needs to supply more than just its own one slot) — when
  // nVars === nInit, compileSingleInit's default nret=1 for a plain
  // CallExpression target already does the right thing.
  if (nInit > 0 && nVars > nInit && stmt.init[nInit - 1].type === 'CallExpression') {

    for (let i = 0; i < nInit - 1; i++) {
      state.allocator.reset(state.regFloor);
      compileSingleInit(stmt.variables[i], stmt.init[i], state);
    }

    state.allocator.reset(state.regFloor);
    const remaining = nVars - (nInit - 1);
    const base = state.allocator.alloc();
    for (let i = 1; i < remaining; i++) state.allocator.alloc();

    compileCallInto(stmt.init[nInit - 1] as N.CallExpression, state, base, remaining);

    for (let i = 0; i < remaining; i++) {
      writeAssignTarget(stmt.variables[nInit - 1 + i], base + i, state);
    }

    return;

  }

  stmt.variables.forEach((v, i) => {
    state.allocator.reset(state.regFloor);
    compileSingleInit(v, stmt.init[i], state);
  });

}


function opForBinary(op: N.BinaryOperator, state: CompileState): number {
  switch (op) {
    case '+': return state.opcodes.ADD;
    case '-': return state.opcodes.SUB;
    case '*': return state.opcodes.MUL;
    case '/': return state.opcodes.DIV;
    case '//': return state.opcodes.IDIV;
    case '%': return state.opcodes.MOD;
    case '^': return state.opcodes.POW;
    case '..': return state.opcodes.CONCAT;
    default:
      throw new Error(`VMify: internal error — unexpected compound-assignment base operator '${op}'`);
  }
}


function compileCompoundAssignment(stmt: N.CompoundAssignmentStatement, state: CompileState): void {

  const opMap: Record<N.CompoundAssignmentStatement['operator'], N.BinaryOperator> = {
    '+=': '+', '-=': '-', '*=': '*', '/=': '/', '//=': '//', '%=': '%', '^=': '^', '..=': '..'
  };

  const binOp = opMap[stmt.operator];
  const opcode = opForBinary(binOp, state);
  const v = stmt.variable;

  if (v.type === 'Identifier') {

    const bid = v.bindingId;
    const local = bid != null ? state.regs.get(bid) : undefined;

    if (local !== undefined) {
      state.allocator.reset(state.regFloor);
      const rhs = state.allocator.alloc();
      compileExpression(stmt.value, state, rhs);
      state.code.push({ op: opcode, a: local, b: local, c: rhs });
      return;
    }

    const box = bid != null ? state.boxIndex.get(bid) : undefined;

    if (box !== undefined) {
      state.allocator.reset(state.regFloor);
      const cur = state.allocator.alloc();
      state.code.push({ op: state.opcodes.GETUPVAL, a: cur, b: box, c: 0 });

      const rhs = state.allocator.alloc();
      compileExpression(stmt.value, state, rhs);

      state.code.push({ op: opcode, a: cur, b: cur, c: rhs });
      state.code.push({ op: state.opcodes.SETUPVAL, a: box, b: cur, c: 0 });
      return;
    }

    state.allocator.reset(state.regFloor);
    const cur = state.allocator.alloc();
    const pc = state.code.length;
    state.code.push({ op: state.opcodes.GETGLOBAL, a: cur, b: keyedGlobalConst(state, pc, v.name), c: 0 });

    const rhs = state.allocator.alloc();
    compileExpression(stmt.value, state, rhs);

    state.code.push({ op: opcode, a: cur, b: cur, c: rhs });

    const pc2 = state.code.length;
    state.code.push({ op: state.opcodes.SETGLOBAL, a: cur, b: keyedGlobalConst(state, pc2, v.name), c: 0 });
    return;

  }

  if (v.type === 'MemberExpression' || v.type === 'IndexExpression') {

    state.allocator.reset(state.regFloor);
    const baseReg = state.allocator.alloc();
    compileExpression(v.base, state, baseReg);

    const keyReg = state.allocator.alloc();
    if (v.type === 'MemberExpression') {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: keyReg, b: keyedConst(state, pc, v.identifier.name), c: 0 });
    } else {
      compileExpression(v.index, state, keyReg);
    }

    const cur = state.allocator.alloc();
    state.code.push({ op: state.opcodes.GETINDEX, a: cur, b: baseReg, c: keyReg });

    const rhs = state.allocator.alloc();
    compileExpression(stmt.value, state, rhs);

    state.code.push({ op: opcode, a: cur, b: cur, c: rhs });

    state.code.push({ op: state.opcodes.SETINDEX, a: baseReg, b: keyReg, c: cur });
    return;

  }

  throw new Error(
    `VMify: unsupported compound-assignment target '${(v as N.Expression).type}'`
  );

}


function compileIf(stmt: N.IfStatement, state: CompileState): void {

  const endJumps: number[] = [];

  for (let i = 0; i < stmt.clauses.length; i++) {

    const clause = stmt.clauses[i];
    const isLast = i === stmt.clauses.length - 1;

    let skipPc = -1;

    if (clause.type !== 'ElseClause') {

      state.allocator.reset(state.regFloor);
      const condReg = state.allocator.alloc();
      compileExpression(clause.condition, state, condReg);

      skipPc = push(state, { op: state.opcodes.JMPIFNOT, a: condReg, b: -1, c: 0 });

    }

    for (const s of clause.body) {
      state.allocator.reset(state.regFloor);
      compileStatement(s, state);
    }

    if (!isLast) {
      endJumps.push(push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 }));
    }

    if (skipPc !== -1) {
      patchJumpTarget(state, skipPc, state.code.length);
    }

  }

  const endPc = state.code.length;
  for (const j of endJumps) {
    patchJumpTarget(state, j, endPc);
  }

}


function compileWhile(stmt: N.WhileStatement, state: CompileState): void {

  const loopStart = state.code.length;

  state.allocator.reset(state.regFloor);
  const condReg = state.allocator.alloc();
  compileExpression(stmt.condition, state, condReg);

  const exitJmp = push(state, { op: state.opcodes.JMPIFNOT, a: condReg, b: -1, c: 0 });

  state.loopStack.push({ continueJumps: [], breakJumps: [] });

  for (const s of stmt.body) {
    state.allocator.reset(state.regFloor);
    compileStatement(s, state);
  }

  const backJmp = push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 });
  patchJumpTarget(state, backJmp, loopStart);

  const exitPc = state.code.length;
  patchJumpTarget(state, exitJmp, exitPc);

  const frame = state.loopStack.pop()!;
  // continue -> re-evaluate the loop condition, same as reaching loopStart
  for (const j of frame.continueJumps) patchJumpTarget(state, j, loopStart);
  for (const j of frame.breakJumps) patchJumpTarget(state, j, exitPc);

}


function compileRepeat(stmt: N.RepeatStatement, state: CompileState): void {

  const loopStart = state.code.length;

  state.loopStack.push({ continueJumps: [], breakJumps: [] });

  for (const s of stmt.body) {
    state.allocator.reset(state.regFloor);
    compileStatement(s, state);
  }

  // continue's target: the point where the `until` condition gets
  // (re-)evaluated. NOT loopStart — repeat's condition must always be
  // (re-)checked before deciding whether to loop again, so jumping to
  // loopStart would skip that check entirely and loop unconditionally.
  const condPc = state.code.length;

  state.allocator.reset(state.regFloor);
  const condReg = state.allocator.alloc();
  compileExpression(stmt.condition, state, condReg);

  // repeat...until cond: loop while cond is FALSE, i.e. jump back to
  // loopStart when NOT cond.
  const backJmp = push(state, { op: state.opcodes.JMPIFNOT, a: condReg, b: -1, c: 0 });
  patchJumpTarget(state, backJmp, loopStart);

  const exitPc = state.code.length;

  const frame = state.loopStack.pop()!;
  for (const j of frame.continueJumps) patchJumpTarget(state, j, condPc);
  for (const j of frame.breakJumps) patchJumpTarget(state, j, exitPc);

}


function compileForNumeric(stmt: N.ForNumericStatement, state: CompileState): void {

  if (stmt.variable.type !== 'Identifier') {
    throw new Error('VMify: for-loop variable must be a plain identifier');
  }

  const loopBid = stmt.variable.bindingId;
  if (loopBid != null && state.boxIndex.has(loopBid)) {
    // See loopVarBindingIds' doc on CompileState: a closure created inside
    // this loop's body captures the loop variable itself. This VM hoists
    // every local (including for-loop control variables) to ONE
    // persistent slot for the whole chunk rather than a fresh one per
    // iteration (see the LIMITATIONS note at the bottom of this file), so
    // every such closure would silently end up sharing the SAME final
    // value instead of each seeing "its" iteration's value the way real
    // Lua's per-iteration fresh locals do. Rejecting this loudly beats
    // shipping that mismatch quietly.
    throw new Error(
      `VMify: closures capturing the for-loop variable '${stmt.variable.name}' are not ` +
      'supported yet — this VM does not give loop variables a fresh binding per ' +
      'iteration, so the closure would see a stale/shared value instead of its own. ' +
      'Copy the loop variable into a plain local declared inside the loop body first ' +
      '(e.g. `local i_ = i`) and capture that instead.'
    );
  }

  const loopReg = loopBid != null ? state.regs.get(loopBid) : undefined;
  if (loopReg === undefined) {
    throw new Error('VMify: internal error — for-loop variable was not hoisted to a register');
  }

  state.allocator.reset(state.regFloor);
  compileExpression(stmt.start, state, loopReg);

  const limitReg = state.allocator.alloc();
  compileExpression(stmt.end, state, limitReg);

  const stepReg = state.allocator.alloc();
  if (stmt.step) {
    compileExpression(stmt.step, state, stepReg);
  } else {
    const pc = state.code.length;
    state.code.push({ op: state.opcodes.LOADK, a: stepReg, b: keyedConst(state, pc, 1), c: 0 });
  }

  // Real Lua evaluates start/limit/step exactly once, before the loop
  // begins, and picks the loop DIRECTION from step's sign at that point
  // (it doesn't re-check every iteration). step may be a non-literal
  // expression whose sign isn't known at compile time, so compute
  // "step >= 0" once here, into its own persistent register, rather than
  // assuming a positive step the way this loop used to.
  //
  // NOTE: stepNonNegReg is NOT necessarily stepReg+1 — compiling a
  // non-trivial step expression (e.g. the UnaryExpression in `-1`, which
  // needs its own scratch operand register) can consume additional
  // temp registers first, pushing the allocator's cursor further ahead
  // than a naive "+1" would assume. Always read the allocator's actual
  // position (via alloc()) rather than hardcoding an offset here.
  const stepNonNegReg = state.allocator.alloc();
  {
    const zeroReg = state.allocator.alloc();
    const pc = state.code.length;
    state.code.push({ op: state.opcodes.LOADK, a: zeroReg, b: keyedConst(state, pc, 0), c: 0 });
    state.code.push({ op: state.opcodes.LE, a: stepNonNegReg, b: zeroReg, c: stepReg });
  }

  const loopStart = state.code.length;

  // limitReg/stepReg/stepNonNegReg must stay alive and untouched for the
  // whole loop — every nested statement/expression compiler resets the
  // allocator through regFloor, so raise it here for the duration of the
  // loop body (and the condition/increment code that also needs it) and
  // restore it on the way out. Without this, an `if` or function call
  // inside the loop body would reset straight back down to the outer
  // floor and silently overwrite these mid-loop (see the vmify bugfix
  // note in the file header — this is exactly the "attempt to call nil
  // value" incident).
  //
  // Use the allocator's actual high-water mark here (NOT a hardcoded
  // "+3") — see the note on stepNonNegReg above for why the offset isn't
  // fixed. high() is guaranteed to be past every register used so far,
  // including zeroReg (a one-off scratch that doesn't itself need to
  // persist, but reserving it too is harmless).
  const outerFloor = state.regFloor;
  state.regFloor = state.allocator.high();

  // cond = (step >= 0) ? (loopReg <= limitReg) : (limitReg <= loopReg).
  // Both branches use the same LE opcode with operands swapped, so no new
  // comparison opcode is needed — just a runtime branch on the
  // once-computed stepNonNegReg, mirroring how `>`/`>=` already reuse
  // LT/LE with swapped operands elsewhere in this compiler.
  state.allocator.reset(state.regFloor);
  const condReg = state.allocator.alloc();
  const negBranchJmp = push(state, { op: state.opcodes.JMPIFNOT, a: stepNonNegReg, b: -1, c: 0 });
  state.code.push({ op: state.opcodes.LE, a: condReg, b: loopReg, c: limitReg });
  const condDoneJmp = push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 });
  patchJumpTarget(state, negBranchJmp, state.code.length);
  state.code.push({ op: state.opcodes.LE, a: condReg, b: limitReg, c: loopReg });
  patchJumpTarget(state, condDoneJmp, state.code.length);

  const exitJmp = push(state, { op: state.opcodes.JMPIFNOT, a: condReg, b: -1, c: 0 });

  state.loopStack.push({ continueJumps: [], breakJumps: [] });

  for (const s of stmt.body) {
    state.allocator.reset(state.regFloor);
    compileStatement(s, state);
  }

  const stepPc = state.code.length; // continue's target: the increment step
  state.allocator.reset(state.regFloor);
  state.code.push({ op: state.opcodes.ADD, a: loopReg, b: loopReg, c: stepReg });

  const backJmp = push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 });
  patchJumpTarget(state, backJmp, loopStart);

  const exitPc = state.code.length;
  patchJumpTarget(state, exitJmp, exitPc);

  const frame = state.loopStack.pop()!;
  for (const j of frame.continueJumps) patchJumpTarget(state, j, stepPc);
  for (const j of frame.breakJumps) patchJumpTarget(state, j, exitPc);

  state.regFloor = outerFloor;

}


function compileForGeneric(stmt: N.ForGenericStatement, state: CompileState): void {

  // for v1, v2, ... in explist do body end
  //
  // Standard 3-value iterator protocol: f (iterator function), s (invariant
  // state), ctrl (control variable). If written as `in someCall(...)`
  // (the overwhelmingly common `in pairs(t)` / `in ipairs(t)` shape),
  // that single call is invoked once with nret=3 to obtain all three at
  // once. If written as explicit `in f, s, ctrl` expressions, each slot is
  // compiled independently (missing trailing slots default to nil, same
  // as real Lua).
  state.allocator.reset(state.regFloor);
  const fReg = state.allocator.alloc();
  const sReg = state.allocator.alloc();
  const cReg = state.allocator.alloc();

  // fReg/sReg/cReg must survive for the whole loop — loopStart re-reads
  // them every iteration (to re-invoke the iterator) and cReg is rewritten
  // before each call, so nothing compiled inside the loop (condition,
  // body, or the per-iteration iterator-call staging below) may reuse
  // these three registers as scratch. Same mechanism as compileForNumeric;
  // see the regFloor field's doc comment and the vmify bugfix note in the
  // file header.
  const outerFloor = state.regFloor;
  state.regFloor = outerFloor + 3;

  if (stmt.iterators.length === 1 && stmt.iterators[0].type === 'CallExpression') {

    // Writes fReg, fReg+1 (sReg), fReg+2 (cReg) — safe because they were
    // just allocated as three consecutive registers above.
    compileCallInto(stmt.iterators[0] as N.CallExpression, state, fReg, 3);

  } else {

    compileExpression(stmt.iterators[0], state, fReg);

    if (stmt.iterators[1]) {
      compileExpression(stmt.iterators[1], state, sReg);
    } else {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: sReg, b: keyedConst(state, pc, null), c: 0 });
    }

    if (stmt.iterators[2]) {
      compileExpression(stmt.iterators[2], state, cReg);
    } else {
      const pc = state.code.length;
      state.code.push({ op: state.opcodes.LOADK, a: cReg, b: keyedConst(state, pc, null), c: 0 });
    }

  }

  const varRegs = stmt.variables.map(v => {
    if (v.type !== 'Identifier') {
      throw new Error('VMify: generic-for variables must be plain identifiers');
    }
    const bid = v.bindingId;
    if (bid != null && state.boxIndex.has(bid)) {
      // See the matching check in compileForNumeric — same reasoning.
      throw new Error(
        `VMify: closures capturing the for-in variable '${v.name}' are not supported ` +
        'yet — this VM does not give loop variables a fresh binding per iteration. ' +
        'Copy it into a plain local declared inside the loop body first and capture that.'
      );
    }
    const r = bid != null ? state.regs.get(bid) : undefined;
    if (r === undefined) {
      throw new Error('VMify: internal error — generic-for variable was not hoisted to a register');
    }
    return r;
  });

  const loopStart = state.code.length;

  // Call the iterator: f(s, ctrl) -> varRegs[0], varRegs[1], ...
  // Staged through scratch temps first (varRegs may not be contiguous with
  // each other, or with a free scratch window), then fanned out via MOVE.
  state.allocator.reset(state.regFloor);
  const callFunc = state.allocator.alloc();
  state.code.push({ op: state.opcodes.MOVE, a: callFunc, b: fReg, c: 0 });

  const argBase = state.allocator.alloc();
  state.code.push({ op: state.opcodes.MOVE, a: argBase, b: sReg, c: 0 });

  const argCtrl = state.allocator.alloc();
  state.code.push({ op: state.opcodes.MOVE, a: argCtrl, b: cReg, c: 0 });

  const retBase = state.allocator.alloc();
  for (let i = 1; i < varRegs.length; i++) state.allocator.alloc();

  state.code.push({
    op: state.opcodes.CALL,
    a: retBase,
    b: callFunc,
    c: argBase,
    nargs: 2,
    nret: Math.max(varRegs.length, 1)
  });

  varRegs.forEach((r, i) => {
    state.code.push({ op: state.opcodes.MOVE, a: r, b: retBase + i, c: 0 });
  });

  // Stop when the FIRST returned value is nil — checked via equality
  // against a loaded nil constant, not truthiness, since `false` is a
  // legal non-terminal value a custom iterator may yield.
  const nilReg = state.allocator.alloc();
  {
    const pc = state.code.length;
    state.code.push({ op: state.opcodes.LOADK, a: nilReg, b: keyedConst(state, pc, null), c: 0 });
  }
  const testReg = state.allocator.alloc();
  state.code.push({ op: state.opcodes.EQ, a: testReg, b: varRegs[0], c: nilReg });

  const exitJmp = push(state, { op: state.opcodes.JMPIF, a: testReg, b: -1, c: 0 });

  // control var := v1, for the next iteration's f(s, ctrl) call.
  state.code.push({ op: state.opcodes.MOVE, a: cReg, b: varRegs[0], c: 0 });

  state.loopStack.push({ continueJumps: [], breakJumps: [] });

  for (const s of stmt.body) {
    state.allocator.reset(state.regFloor);
    compileStatement(s, state);
  }

  const backJmp = push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 });
  patchJumpTarget(state, backJmp, loopStart);

  const exitPc = state.code.length;
  patchJumpTarget(state, exitJmp, exitPc);

  const frame = state.loopStack.pop()!;
  // continue -> re-invoke the iterator, same as reaching loopStart
  for (const j of frame.continueJumps) patchJumpTarget(state, j, loopStart);
  for (const j of frame.breakJumps) patchJumpTarget(state, j, exitPc);

  state.regFloor = outerFloor;

}


// Compiles a `return` — used both for the chunk's own trailing return (the
// only place this ever ran before) AND, now, for a `return` reached mid-body
// via compileStatement (inside an `if`, `for`, `while`, `do`, etc.). Either
// way it's the same RETURN opcode: the runtime dispatcher's RETURN arm emits
// a real Lua `return`, which unwinds the whole interpreter loop immediately
// regardless of where in state.code it's reached, so an "early" return needs
// no special jump/cleanup handling beyond emitting the instruction in place.
function compileReturnStatement(stmt: N.ReturnStatement, state: CompileState): void {

  const args = stmt.arguments ?? [];
  const lastArg = args[args.length - 1];

  // Same "only the last expression expands" rule as call arguments and
  // multi-assignment: `return a, ...` returns `a` plus EVERY remaining
  // vararg, and `return a, f()` returns `a` plus EVERY value f() returns
  // — not just the first of each, unlike every other position in the
  // list. See the spreadKind doc on the Instr interface.
  const varargSpread = args.length > 0 && lastArg.type === 'VarargLiteral';
  const callSpread = !varargSpread && args.length > 0 && lastArg.type === 'CallExpression';
  const fixedArgs = (varargSpread || callSpread) ? args.slice(0, -1) : args;

  // Fixed convention (kept from earlier versions): the fixed prefix
  // return values live in registers 0..n-1 regardless of how many
  // hoisted locals also live there — safe because a RETURN always
  // unwinds the whole VM loop immediately, so nothing reads those
  // locals' old values afterward, early or trailing alike.
  state.allocator.reset(state.regFloor);
  fixedArgs.forEach((arg, i) => compileExpression(arg, state, i));

  let spreadKind: 0 | 1 | 2 = 0;
  if (varargSpread) {
    spreadKind = 1;
  } else if (callSpread) {
    // The capturing call's own scratch/arg registers must not alias the
    // fixed prefix values we just wrote into 0..fixedArgs.length-1.
    state.allocator.reset(Math.max(state.allocator.high(), fixedArgs.length));
    const scratch = state.allocator.alloc();
    compileCallIntoWithCapture(lastArg as N.CallExpression, state, scratch);
    spreadKind = 2;
  }

  state.code.push({ op: state.opcodes.RETURN, a: 0, b: 0, c: 0, nargs: fixedArgs.length, spreadKind });

}

function compileStatement(stmt: N.Statement, state: CompileState): void {

  switch (stmt.type) {

    case 'ReturnStatement':
      compileReturnStatement(stmt, state);
      return;

    case 'AssignmentStatement':
      compileAssignment(stmt, state);
      return;

    case 'CompoundAssignmentStatement':
      state.allocator.reset(state.regFloor);
      compileCompoundAssignment(stmt, state);
      return;

    case 'CallStatement': {

      const call = stmt.expression;

      const asCall: N.CallExpression =
        call.type === 'CallExpression' ? call :
        call.type === 'TableCallExpression' ? callExpr(call.base, [call.arguments[0]]) :
        call.type === 'StringCallExpression' ? callExpr(call.base, [call.argument]) :
        (() => { throw new Error(`VMify: unsupported call statement form '${(call as N.Expression).type}'`); })();

      // Discard the result into a scratch register — CALL still needs an
      // `a` target even when the value is unused.
      state.allocator.reset(state.regFloor);
      const scratch = state.allocator.alloc();
      compileCallInto(asCall, state, scratch);
      return;

    }

    case 'IfStatement':
      compileIf(stmt, state);
      return;

    case 'WhileStatement':
      compileWhile(stmt, state);
      return;

    case 'RepeatStatement':
      compileRepeat(stmt, state);
      return;

    case 'ForNumericStatement':
      compileForNumeric(stmt, state);
      return;

    case 'ForGenericStatement':
      compileForGeneric(stmt, state);
      return;

    case 'DoStatement':
      for (const s of stmt.body) {
        state.allocator.reset(state.regFloor);
        compileStatement(s, state);
      }
      return;

    case 'BreakStatement': {
      const frame = state.loopStack[state.loopStack.length - 1];
      if (!frame) {
        throw new Error('VMify: break used outside of a loop');
      }
      frame.breakJumps.push(push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 }));
      return;
    }

    case 'ContinueStatement': {
      const frame = state.loopStack[state.loopStack.length - 1];
      if (!frame) {
        throw new Error('VMify: continue used outside of a loop');
      }
      frame.continueJumps.push(push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 }));
      return;
    }

    case 'GotoStatement': {
      const pc = push(state, { op: state.opcodes.JMP, a: 0, b: -1, c: 0 });
      state.pendingGotos.push({ name: stmt.label, pc });
      return;
    }

    case 'LabelStatement': {
      if (state.labels.has(stmt.name)) {
        throw new Error(`VMify: duplicate label '${stmt.name}'`);
      }
      state.labels.set(stmt.name, state.code.length);
      return;
    }

    case 'FunctionDeclaration': {
      // Only reaches here as a genuine STATEMENT with a target: `function
      // foo() end` (global) or `function tbl.field()` / `function
      // tbl:method()`. `local function` was already rewritten into an
      // AssignmentStatement by HOIST (see hoistNamesFromStatement), so it
      // never reaches this case — and an anonymous one can't be a
      // statement at all (the parser wouldn't produce it). Desugars to
      // `<target> = function() ... end`, same as real Lua does.
      if (stmt.identifier === null) {
        throw new Error('VMify: internal error — anonymous FunctionDeclaration reached compileStatement');
      }
      const anon: N.FunctionDeclaration = { ...stmt, identifier: null, isLocal: false };
      const tmp = state.allocator.alloc();
      compileExpression(anon, state, tmp);
      writeAssignTarget(stmt.identifier as N.AssignmentTarget, tmp, state);
      return;
    }

    default:
      throw new Error(
        `VMify: unsupported statement type '${stmt.type}'`
      );

  }

}


// ======================================================
// RUNTIME CODEGEN
// ======================================================

function buildPoolDecl(poolName: string, pool: ConstantPool): N.LocalStatement {

  return localStmt(
    [ident(poolName)],
    [tableCtor(pool.values.map(v => tableValue(constNodeFor(v))))]
  );

}


// `local upvalsName = { {v=nil}, {v=nil}, ... }` — one shared box per
// captured top-level binding, declared once before both the raw closure
// pool (which references these by name) and the dispatch loop (which
// addresses them by index via GETUPVAL/SETUPVAL). See the CLOSURES
// section above.
function buildUpvalsDecl(upvalsName: string, count: number): N.LocalStatement {

  const box = (): N.Expression => tableCtor([
    {
      type: 'TableKeyString',
      key: { type: 'Identifier', name: 'v', attribute: null, typeAnnotation: null, scope: 'global', isField: true, bindingId: null, range: [0, 0], loc: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } },
      value: nilLit(),
      range: [0, 0], loc: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }
    } as N.TableKeyString
  ]);

  return localStmt(
    [ident(upvalsName)],
    [tableCtor(Array.from({ length: count }, box).map(tableValue))]
  );

}

// `local rawPoolName = { <closure literal>, <closure literal>, ... }` —
// unlike the regular constant pool, these entries are real Lua function
// expressions embedded directly as AST (not JSON-safe data run through
// constNodeFor), since a closure value can't be represented as pool data.
// LOADRAW's `b` operand is a plain, non-keyed index into this table.
function buildRawPoolDecl(rawPoolName: string, entries: N.Expression[]): N.LocalStatement {

  return localStmt(
    [ident(rawPoolName)],
    [tableCtor(entries.map(tableValue))]
  );

}


const DUMMY_RANGE: [number, number] = [0, 0];
const DUMMY_LOC: N.SourceLocation = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };

// GETGLOBAL/SETGLOBAL must NOT resolve through `_G` at runtime: `_G` is not
// the real global environment on every host (Roblox/Luau's `_G` is an
// empty, unrelated shared table — builtins like `print` never live there),
// so `_G["print"]` silently evaluates to nil and any call blows up with
// "attempt to call nil value". Instead we build a plain local reference
// table once, up front — `local ENV = { print = print, warn = warn, ... }`
// — using REAL Identifier nodes for the values (never touched by any
// string/const obfuscation pass) so each field just captures whatever the
// name actually resolves to at the point this chunk runs, exactly the way
// global-mapping.ts's own reference table does it. The runtime then reads
///writes ENV[name] instead of _G[name].
function buildEnvDecl(envName: string, usedGlobals: Set<string>): N.LocalStatement {

  const fields: N.TableField[] = Array.from(usedGlobals).map((name) => ({
    type: 'TableKeyString',
    key: {
      type: 'Identifier', name, attribute: null, typeAnnotation: null,
      scope: 'global', isField: true, bindingId: null,
      range: DUMMY_RANGE, loc: DUMMY_LOC
    },
    value: {
      type: 'Identifier', name, attribute: null, typeAnnotation: null,
      scope: 'global', isField: false, bindingId: null,
      range: DUMMY_RANGE, loc: DUMMY_LOC
    },
    range: DUMMY_RANGE, loc: DUMMY_LOC
  } as N.TableKeyString));

  return localStmt([ident(envName)], [tableCtor(fields)]);

}


function buildCodeDecl(codeName: string, code: Instr[]): N.LocalStatement {

  return localStmt(
    [ident(codeName)],
    [
      tableCtor(
        code.map(ins =>
          tableValue(
            tableCtor([
              tableValue(numLit(ins.op)),
              tableValue(numLit(ins.a)),
              tableValue(numLit(ins.b)),
              tableValue(numLit(ins.c)),
              tableValue(numLit(ins.nargs ?? 0)),
              tableValue(numLit(ins.spreadKind ?? 0)),
              tableValue(numLit(ins.nret ?? 1)),
              tableValue(numLit(ins.captureMultret ? 1 : 0))
            ])
          )
        )
      )
    ]
  );

}


// The runtime is generated as a source template (no user data is
// interpolated — only our own generated identifiers and numeric
// constants), parsed via parseSnippet.
//
//  1. keyAt(pc) is reproduced in Lua exactly (same LCG constants) so the
//     interpreter can regenerate the per-instruction key stream instead of
//     using one static key — a reverser recovering key[0] no longer
//     recovers every other instruction's key for free.
//  2. dispatch is hash-bucketed: `disp[op % BUCKETS]` maps to a small
//     if-chain instead of one flat if-elseif over every opcode. This is a
//     speed bump, not real indirection (Lua 5.1 has no computed goto), but
//     it means opcode adjacency in source no longer mirrors opcode value
//     adjacency, which defeats simple linear-scan diffing between builds.
//
// IMPORTANT register-indexing note: the compiler's register numbers
// (a/b/c) are always 0-based, but the runtime `regs` table is a plain Lua
// table addressed 1-based. `aName` and `cName` are converted once at
// decode time (`ins[2] + 1`, `ins[4] + 1`). `bName` is deliberately left
// un-converted at decode time, because `b` does double duty: for
// LOADK/GETGLOBAL/SETGLOBAL/JMP*/CALL's arg-base it is a *keyed-encoded
// value* (pool index or jump pc) that must be xor-decoded BEFORE any +1 is
// applied — adding 1 first would corrupt the xor. But for
// MOVE/GETINDEX/SETINDEX/arithmetic/comparison/UNM/NOT/LEN/CALL's function
// register, `b` IS a plain 0-based register number, so those branches must
// add the `+ 1` themselves at the point of use (`regs[b + 1]`), same as
// `a` and `c` already do.
function buildRuntimeSource(names: {
  poolName: string; codeName: string; rawPoolName: string; upvalsName: string;
  xorName: string; keyName: string;
  regsName: string; pcName: string; insName: string; opName: string;
  aName: string; bName: string; cName: string; nName: string;
  argsName: string; iName: string; bucketName: string; vaName: string;
  jumpedName: string; envName: string; mrName: string;
}, opcodes: Record<OpName, number>, keySeed: number): string {

  const {
    poolName, codeName, rawPoolName, upvalsName, xorName, keyName,
    regsName, pcName, insName, opName,
    aName, bName, cName, nName, argsName, iName, bucketName, vaName, jumpedName,
    envName, mrName
  } = names;

  const BUCKETS = 4;

  const buckets: OpName[][] = Array.from({ length: BUCKETS }, () => []);
  for (const name of OPCODE_NAMES) {
    buckets[opcodes[name] % BUCKETS].push(name);
  }

  const bReg = `(${bName} + 1)`;
  // FIX (bug 2): use the per-instruction computed key value directly —
  // never reference `keyName` (the function itself) as an xor operand.
  const keyVal = `${keyName}_v`;

  // NOTE: this used to `goto` a per-bucket label to skip the remaining
  // sibling `if op == ...` checks once a JMP-family opcode had run. That's
  // not just an optimization we can drop — it's flat-out invalid here: the
  // runtime source below is reparsed through this project's own parser
  // (see parseSnippet(runtimeSource, dialect) at the bottom of this file),
  // and goto/::label:: isn't valid syntax in *either* dialect this project
  // supports (it's a Lua 5.2+ feature; Luau never adopted it — see
  // dialect.ts). Dropping it is free: each arm is gated on an exact `op ==
  // <opcode>` match and opcodes are unique, so at most one arm per bucket
  // ever runs regardless of order — the remaining sibling checks after a
  // JMP-family opcode fires are just a few dead comparisons, not a
  // correctness concern.
  function branchFor(name: OpName): string {

    switch (name) {
      case 'MOVE':
        return `${regsName}[${aName}] = ${regsName}[${bReg}]`;
      case 'LOADK':
        return `${regsName}[${aName}] = ${poolName}[${xorName}(${bName}, ${keyVal}) + 1]`;
      case 'GETGLOBAL':
        return `${regsName}[${aName}] = ${envName}[${poolName}[${xorName}(${bName}, ${keyVal}) + 1]]`;
      case 'SETGLOBAL':
        return `${envName}[${poolName}[${xorName}(${bName}, ${keyVal}) + 1]] = ${regsName}[${aName}]`;
      case 'GETINDEX':
        return `${regsName}[${aName}] = ${regsName}[${bReg}][${regsName}[${cName}]]`;
      case 'SETINDEX':
        return `${regsName}[${aName}][${regsName}[${bReg}]] = ${regsName}[${cName}]`;
      case 'NEWTABLE':
        return `${regsName}[${aName}] = {}`;
      case 'ADD':
        return `${regsName}[${aName}] = ${regsName}[${bReg}] + ${regsName}[${cName}]`;
      case 'SUB':
        return `${regsName}[${aName}] = ${regsName}[${bReg}] - ${regsName}[${cName}]`;
      case 'MUL':
        return `${regsName}[${aName}] = ${regsName}[${bReg}] * ${regsName}[${cName}]`;
      case 'DIV':
        return `${regsName}[${aName}] = ${regsName}[${bReg}] / ${regsName}[${cName}]`;
      case 'IDIV':
        return `${regsName}[${aName}] = math.floor(${regsName}[${bReg}] / ${regsName}[${cName}])`;
      case 'MOD':
        return `${regsName}[${aName}] = ${regsName}[${bReg}] % ${regsName}[${cName}]`;
      case 'POW':
        return `${regsName}[${aName}] = ${regsName}[${bReg}] ^ ${regsName}[${cName}]`;
      case 'CONCAT':
        return `${regsName}[${aName}] = ${regsName}[${bReg}] .. ${regsName}[${cName}]`;
      case 'UNM':
        return `${regsName}[${aName}] = -${regsName}[${bReg}]`;
      case 'NOT':
        return `${regsName}[${aName}] = not ${regsName}[${bReg}]`;
      case 'LEN':
        return `${regsName}[${aName}] = #${regsName}[${bReg}]`;
      case 'EQ':
        return `${regsName}[${aName}] = (${regsName}[${bReg}] == ${regsName}[${cName}])`;
      case 'LT':
        return `${regsName}[${aName}] = (${regsName}[${bReg}] < ${regsName}[${cName}])`;
      case 'LE':
        return `${regsName}[${aName}] = (${regsName}[${bReg}] <= ${regsName}[${cName}])`;
      case 'JMP':
        return `${pcName} = ${xorName}(${bName}, ${keyVal})\n      ${jumpedName} = true`;
      case 'JMPIF':
        return (
          `if ${regsName}[${aName}] then\n` +
          `        ${pcName} = ${xorName}(${bName}, ${keyVal})\n` +
          `        ${jumpedName} = true\n` +
          `      end`
        );
      case 'JMPIFNOT':
        return (
          `if not ${regsName}[${aName}] then\n` +
          `        ${pcName} = ${xorName}(${bName}, ${keyVal})\n` +
          `        ${jumpedName} = true\n` +
          `      end`
        );
      case 'VARARG':
        return `${regsName}[${aName}] = ${vaName}[1]`;
      case 'TOSTRING':
        return `${regsName}[${aName}] = tostring(${regsName}[${bReg}])`;
      case 'GETUPVAL':
        // b is a plain (non-keyed) 0-based index into upvals, same
        // convention as LOADRAW's b below.
        return `${regsName}[${aName}] = ${upvalsName}[${bName} + 1].v`;
      case 'SETUPVAL':
        // Here `a` is the (already 1-based) upvals index and `b` is a
        // plain 0-based register needing the manual +1, same convention
        // as every other op where b is a real register operand.
        return `${upvalsName}[${aName}].v = ${regsName}[${bReg}]`;
      case 'LOADRAW':
        // b is a plain (non-keyed) 0-based index into rawPool — closure
        // values aren't run through the xor keystream since they're not
        // user data, just internal function objects built once up front.
        return `${regsName}[${aName}] = ${rawPoolName}[${bName} + 1]`;
      case 'SPREADVARARG':
        // b is a plain (non-keyed) 1-based starting array index into the
        // table itself, not a register.
        return (
          `for __si = 1, #${vaName} do ` +
          `${regsName}[${aName}][${bName} + __si - 1] = ${vaName}[__si] end`
        );
      case 'SPREADMULTRET':
        return (
          `for __si = 1, #${mrName} do ` +
          `${regsName}[${aName}][${bName} + __si - 1] = ${mrName}[__si] end`
        );
      case 'CALL': {
        return (
          `local ${argsName} = {}\n` +
          `    local ${iName}n = ${nName}\n` +
          `    for ${iName} = 1, ${nName} do ${argsName}[${iName}] = ${regsName}[${cName} + ${iName} - 1] end\n` +
          `    if ${insName}[6] == 1 then\n` +
          `      for ${iName} = 1, #${vaName} do ${argsName}[${nName} + ${iName}] = ${vaName}[${iName}] end\n` +
          `      ${iName}n = ${nName} + #${vaName}\n` +
          `    elseif ${insName}[6] == 2 then\n` +
          `      for ${iName} = 1, #${mrName} do ${argsName}[${nName} + ${iName}] = ${mrName}[${iName}] end\n` +
          `      ${iName}n = ${nName} + #${mrName}\n` +
          `    end\n` +
          `    local __rets = { ${regsName}[${bReg}](table.unpack(${argsName}, 1, ${iName}n)) }\n` +
          `    if ${insName}[8] == 1 then ${mrName} = __rets end\n` +
          `    local __nret = ${insName}[7] or 1\n` +
          `    for __ri = 1, __nret do ${regsName}[${aName} + __ri - 1] = __rets[__ri] end`
        );
      }
      case 'RETURN':
        // spreadKind (ins[6]) mirrors CALL's: 0 = just the `nargs` fixed
        // registers, 1 = `...` appended after them, 2 = the shared multret
        // buffer (the most recently captured trailing call) appended after
        // them — see the spreadKind doc on the Instr interface. All three
        // funnel through a fresh __rt table rather than mutating `regs`
        // directly, since `regs` may hold live hoisted-local values beyond
        // index `nargs` that the spread source must not stomp on.
        return (
          `do\n` +
          `      if ${insName}[6] == 1 then\n` +
          `        local __rt = {}\n` +
          `        for __i = 1, ${nName} do __rt[__i] = ${regsName}[__i] end\n` +
          `        for __i = 1, #${vaName} do __rt[${nName} + __i] = ${vaName}[__i] end\n` +
          `        return table.unpack(__rt, 1, ${nName} + #${vaName})\n` +
          `      elseif ${insName}[6] == 2 then\n` +
          `        local __rt = {}\n` +
          `        for __i = 1, ${nName} do __rt[__i] = ${regsName}[__i] end\n` +
          `        for __i = 1, #${mrName} do __rt[${nName} + __i] = ${mrName}[__i] end\n` +
          `        return table.unpack(__rt, 1, ${nName} + #${mrName})\n` +
          `      else\n` +
          `        if ${nName} == 0 then return end\n` +
          `        return table.unpack(${regsName}, 1, ${nName})\n` +
          `      end\n` +
          `    end`
        );
      case 'NOP':
      case 'XOR':
        return `${regsName}[${aName}] = ${xorName}(${regsName}[${bReg}], ${regsName}[${cName}])`;
      default:
        throw new Error(`VMify: no runtime codegen for opcode '${name}'`);
    }

  }

  const bucketBlocks = buckets.map((names, idx) => {

    const arms = names.map(n =>
      `    if ${opName} == ${opcodes[n]} then\n` +
      `      ${branchFor(n)}\n` +
      `    end`
    ).join('\n');

    return (
      `  if ${bucketName} == ${idx} then\n` +
      arms + '\n' +
      `  end`
    );

  }).join('\n');

  // FIX (bug 2 cont'd): the trailing `.replace(...)` post-processing step
  // is gone — it never matched anything (its pattern looked for
  // `keyName(bName, keyName)`, but every branch actually emitted
  // `xorName(bName, keyName)`, so it was silently a no-op). branchFor now
  // emits the correct `keyVal` (`${keyName}_v`) directly, so no
  // post-processing is needed at all.
  return `
local function ${xorName}(a, b)
  local r = 0
  local bit = 1
  while a > 0 or b > 0 do
    local aa = a % 2
    local bb = b % 2
    if aa ~= bb then
      r = r + bit
    end
    a = math.floor(a / 2)
    b = math.floor(b / 2)
    bit = bit * 2
  end
  return r
end

-- Reproduces the compile-time key stream: keyAt(seed, pc) in vmify.ts.
local function ${keyName}(pc)
  local x = (${keySeed} + pc * 2654435761) % 4294967296
  x = (x * 1664525 + 1013904223) % 4294967296
  return (x % 251) + 1
end

local ${vaName} = { ... }
-- Shared "most recent captured call" return-value buffer, used to expand
-- a plain call (not '...') that sits in the LAST position of a call's
-- argument list or a return statement into ALL of its return values
-- (spreadKind 2 — see the Instr.spreadKind doc in vmify.ts).
local ${mrName} = {}

local ${regsName} = {}
local ${pcName} = 0

while true do
  local ${insName} = ${codeName}[${pcName} + 1]
  if not ${insName} then break end

  local ${opName} = ${insName}[1]
  local ${aName} = ${insName}[2] + 1
  local ${bName} = ${insName}[3]
  local ${cName} = ${insName}[4] + 1
  local ${nName} = ${insName}[5]
  local ${keyName}_v = ${keyName}(${pcName})
  local ${bucketName} = ${opName} % ${BUCKETS}
  local ${jumpedName} = false

${bucketBlocks}

  if not ${jumpedName} then ${pcName} = ${pcName} + 1 end
end
`;

}


// ======================================================
// MAIN PASS
// ======================================================

export const vmify:

Pass<Record<string, never>> =

(chunk: N.Chunk, ctx: PassContext): N.Chunk => {

  // Scanned on the pristine, pre-HOIST tree (resolveScopes' bindingId/scope
  // marks are what this reads) — see computeNeededBoxes' doc above.
  const neededBoxes = computeNeededBoxes(chunk.body);

  const body = chunk.body.slice();

  if (body.length === 0) return chunk;

  let trailingReturn: N.ReturnStatement | null = null;

  if (body[body.length - 1].type === 'ReturnStatement') {
    trailingReturn = body.pop() as N.ReturnStatement;
  }

  const hoisted: N.Identifier[] = [];
  const stmts = hoistAll(body, hoisted);

  // Split hoisted locals into plain registers vs. boxed (captured by some
  // nested closure) — see CompileState.regs/boxIndex and the CLOSURES
  // section. Every hoisted Identifier has a real bindingId (they're all
  // genuine declaration sites that went through resolveScopes upstream).
  const regs = new Map<number, number>();
  const boxIndex = new Map<number, number>();
  for (const id of hoisted) {
    const bid = id.bindingId!;
    if (neededBoxes.has(bid)) {
      boxIndex.set(bid, boxIndex.size);
    } else {
      regs.set(bid, regs.size);
    }
  }

  const opcodes = buildShuffledOpcodes();
  const keySeed = randInt(1, 2_147_483_647);

  const pool = new ConstantPool();
  const allocator = new RegisterAllocator();

  const used = new Set<string>();
  const upvalsName = randomVarName(used);

  const state: CompileState = {
    pool,
    regs,
    boxIndex,
    rawPool: [],
    upvalsName,
    allocator,
    regFloor: regs.size,
    opcodes,
    keySeed,
    code: [],
    loopStack: [],
    labels: new Map(),
    pendingGotos: [],
    usedGlobals: new Set()
  };

  for (const stmt of stmts) {
    allocator.reset(regs.size);
    compileStatement(stmt, state);
  }

  if (trailingReturn) {
    compileReturnStatement(trailingReturn, state);
  }

  // Resolve every goto against the labels collected while compiling above
  // (a goto may legally jump forward to a label compiled after it).
  for (const { name, pc } of state.pendingGotos) {
    const dest = state.labels.get(name);
    if (dest === undefined) {
      throw new Error(`VMify: goto references undefined label '${name}'`);
    }
    patchJumpTarget(state, pc, dest);
  }

  // NOTE: `used` already has upvalsName in it (seeded before compilation —
  // see the top of this function, where compileClosureLiteral needed the
  // name available up front). Reusing the same set here just means the
  // rest of these generated names are guaranteed not to collide with it.
  const names = {
    poolName: randomVarName(used),
    codeName: randomVarName(used),
    rawPoolName: randomVarName(used),
    upvalsName: state.upvalsName,
    xorName: randomVarName(used),
    keyName: randomVarName(used),
    regsName: randomVarName(used),
    pcName: randomVarName(used),
    insName: randomVarName(used),
    opName: randomVarName(used),
    aName: randomVarName(used),
    bName: randomVarName(used),
    cName: randomVarName(used),
    nName: randomVarName(used),
    argsName: randomVarName(used),
    iName: randomVarName(used),
    bucketName: randomVarName(used),
    vaName: randomVarName(used),
    jumpedName: randomVarName(used),
    envName: randomVarName(used),
    mrName: randomVarName(used)
  };

  const poolDecl = buildPoolDecl(names.poolName, pool);
  const codeDecl = buildCodeDecl(names.codeName, state.code);
  const envDecl = buildEnvDecl(names.envName, state.usedGlobals);
  // Must come before rawPoolDecl: the embedded closures in rawPoolDecl
  // reference `upvals` by name (real Lua lexical capture), so it has to
  // already be a declared local at that point in the source.
  const upvalsDecl = buildUpvalsDecl(names.upvalsName, boxIndex.size);
  const rawPoolDecl = buildRawPoolDecl(names.rawPoolName, state.rawPool);

  const dialect: DialectName = ctx.dialect.name;

  const runtimeSource = buildRuntimeSource(names, opcodes, keySeed);
  const runtimeChunk = parseSnippet(runtimeSource, dialect);

  const VMIFY_DEBUG = false;
  if (VMIFY_DEBUG) {
    const inv: Record<number, string> = {};
    for (const k of Object.keys(opcodes) as (keyof typeof opcodes)[]) inv[opcodes[k]] = k;
    state.code.forEach((ins, pc) => {
      console.error(
        `pc=${pc} ${inv[ins.op]}(${ins.op}) a=${ins.a} b=${ins.b} c=${ins.c} nargs=${ins.nargs} spreadKind=${ins.spreadKind} nret=${ins.nret} captureMultret=${ins.captureMultret}`
      );
    });
  }

  const finalChunk: N.Chunk = {
    ...chunk,
    body: [
      poolDecl,
      codeDecl,
      envDecl,
      upvalsDecl,
      rawPoolDecl,
      ...runtimeChunk.body
    ]
  };

  resolveScopes(finalChunk);

  return finalChunk;

};


// ======================================================
// LIMITATIONS (fail loudly, never silently drop or mis-compile code)
// ======================================================
//
// Still NOT supported, and will throw rather than silently mis-compile:
//   - a closure capturing a numeric-for/generic-for LOOP VARIABLE itself
//     (as opposed to an ordinary local/param, which works — see the
//     CLOSURES section). This VM hoists loop control variables to ONE
//     persistent slot for the whole chunk rather than a fresh one per
//     iteration, so such a closure would see a stale/shared value instead
//     of "its" iteration's value — rejected loudly at compile time in
//     compileForNumeric/compileForGeneric instead of shipping that
//     mismatch quietly. Workaround: copy the loop variable into a plain
//     local declared inside the loop body and capture that instead.
//   - goto/label are resolved in one flat, chunk-wide namespace rather
//     than enforcing real Lua's goto-scoping rules (can't jump into a
//     local's scope from outside) — this is a deliberate relaxation, not
//     a bug, and is unrelated to the point below.
//
// The following used to be listed here as unsupported; all four were
// actually closed out by the v3 additions above and are fully compiled,
// not just parsed — this note used to be stale:
//   - '//' floor division and '//=' floor-division-assign desugar to the
//     IDIV opcode (`math.floor(b / c)` at runtime) — see opForBinary and
//     the BinaryExpression/compileCompoundAssignment cases.
//   - the numeric `for` loop does not assume a positive step. start/
//     limit/step are evaluated once, step's sign is captured into
//     stepNonNegReg up front (matching real Lua's "direction decided
//     once, before the loop runs" semantics), and the per-iteration
//     bound check branches between `loopReg <= limitReg` and
//     `limitReg <= loopReg` off of that — see compileForNumeric.
//   - InterpolatedStringExpression routes every interpolated value
//     through the TOSTRING opcode before CONCAT, matching Luau's real
//     interpolation semantics (booleans/nil/tables stringify instead of
//     raising a bare-`..` runtime error).
//   - closures / nested function declarations / upvalues, AND the "two
//     sibling `local x` in disjoint scopes collide" register bug, were
//     both closed out by the v4 additions above: `regs`/`boxIndex` are
//     keyed by bindingId (not name) now, so two genuinely different `x`
//     bindings never share a slot regardless of whether their names
//     match — see HOIST and the CLOSURES section.
//
// Not a limitation, just worth calling out explicitly: a call used as a
// non-last argument to another call, or as a non-last element of a
// return/assignment list, still only contributes its first return value
// — only the LAST position in an argument list, return list, or
// multi-assignment right-hand side gets true multi-value / vararg-spread
// treatment. That's intentional and matches real Lua's own "only the
// last expression in a list expands" rule, not a gap to fix.