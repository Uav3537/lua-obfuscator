import * as N from '../ast/nodes';
import { DialectFlags } from '../dialect';

export interface PassContext {
  dialect: DialectFlags;
}

export type StepConfig =
  | { name: 'Vmify' }
  | { name: 'RenameVariables' }
  | { name: 'ConstantArray' }
  | { name: 'EncryptStrings' }
  | { name: 'EncryptNumbers' }
  | { name: 'StringsToExpressions'; min?: number; max?: number }
  | { name: 'NumbersToExpressions'; min?: number; max?: number }
  | { name: 'InsertJunk'; probability?: number; maxPerBlock?: number }
  | { name: "GlobalMapping"; globalTableName?: string }
  | { name: "WrapInFunction" }

export interface ObfuscateOptions {
  steps: StepConfig[];
  /** Emit the final output as a single `;`-joined line instead of pretty-printed/indented. Default: false. */
  minify?: boolean;
}

export type Pass<Opts = unknown> = (chunk: N.Chunk, ctx: PassContext, opts: Opts) => N.Chunk;
