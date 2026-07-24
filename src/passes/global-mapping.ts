import * as N from '../ast/nodes';
import { Pass, PassContext } from './types';
import { randomKey } from '../utils/random';
import { ident } from '../ast/builders';
import { resolveScopes } from '../analysis/scope';

const dummyRange: [number, number] = [0, 0];
const dummyLoc = { 
  start: { line: 0, column: 0 }, 
  end: { line: 0, column: 0 } 
};

export const globalMapping: Pass<{ globalTableName?: string }> = (chunk, ctx, options = {}) => {
  const globalTableName = options.globalTableName ?? 'G';
  const keyMap = new Map<string, string>();

  // Passes upstream (rename-variables, vmify, ...) can hoist/rewrite
  // variables in ways that shift what's actually still a global by the time
  // this pass runs, so re-resolve scopes fresh rather than trusting
  // whatever `.scope` the parser or an earlier pass happened to leave
  // behind.
  resolveScopes(chunk);

  const transform = (node: any): any => {
    if (!node || typeof node !== 'object') return node;

    if (node.type === 'Identifier' && node.name) {
      // Only an actual global *reference* gets rewritten into G["key"].
      // Everything else must pass through untouched:
      //   - isField identifiers (member/method names, table-key-string
      //     names, funcname trailing segments) aren't variables at all.
      //   - locals/parameters/upvalues (node.scope !== 'global') are real
      //     bindings resolveScopes() found in an enclosing scope — turning
      //     them into table lookups would silently change what they refer
      //     to (and break shadowing).
      if (node.isField || node.scope !== 'global') {
        for (const key in node) {
          if (key === 'range' || key === 'loc') continue;
          if (Array.isArray(node[key])) {
            node[key] = node[key].map(transform);
          } else {
            node[key] = transform(node[key]);
          }
        }
        return node;
      }

      if (!keyMap.has(node.name)) {
        keyMap.set(node.name, randomKey(5));
      }

      const key = keyMap.get(node.name)!;

      return {
        type: 'IndexExpression',
        base: ident(globalTableName),
        index: {
          type: 'StringLiteral',
          value: key,
          raw: `"${key}"`,
          range: dummyRange,
          loc: dummyLoc
        },
        range: dummyRange,
        loc: dummyLoc
      } as N.IndexExpression;
    }

    for (const key in node) {
      if (key === 'range' || key === 'loc') continue;
      if (Array.isArray(node[key])) {
        node[key] = node[key].map(transform);
      } else {
        node[key] = transform(node[key]);
      }
    }

    return node;
  };

  // Transform 먼저 실행
  transform(chunk);

  // Global Table 생성
  const globalFields: N.TableField[] = Array.from(keyMap.entries()).map(([name, key]) => ({
    type: 'TableKeyString',
    key: {
      type: 'Identifier',
      name: key,
      attribute: null,
      typeAnnotation: null,
      scope: 'global',
      isField: true,
      bindingId: null,
      range: dummyRange,
      loc: dummyLoc
    },
    value: {
      type: 'Identifier',
      name: name,
      attribute: null,
      typeAnnotation: null,
      scope: 'global',
      isField: false,
      bindingId: null,
      range: dummyRange,
      loc: dummyLoc
    },
    range: dummyRange,
    loc: dummyLoc
  }));

  const globalTable: N.LocalStatement = {
    type: 'LocalStatement',
    variables: [{
      type: 'Identifier',
      name: globalTableName,
      attribute: null,
      typeAnnotation: null,
      scope: 'local',
      isField: false,
      bindingId: null,
      range: dummyRange,
      loc: dummyLoc
    }],
    init: [{
      type: 'TableConstructorExpression',
      fields: globalFields,
      range: dummyRange,
      loc: dummyLoc
    }],
    range: dummyRange,
    loc: dummyLoc
  };

  // chunk 맨 앞에 삽입
  if (!chunk.body) chunk.body = [];
  chunk.body.unshift(globalTable);

  return chunk;
};