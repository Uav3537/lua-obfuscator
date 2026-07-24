import { Lexer } from './lexer';
import { TokenType } from './tokens';
import { resolveDialect } from '../dialect';

const sample = `
local function greet(name: string)
    local count = 0
    for i = 1, 3 do
        count += 1
        if i == 2 then
            continue
        end
        print(\`Hello {name}, iteration {i}!\`)
    end
    local x <const> = 42
    return count
end
`;

const tokens = new Lexer(sample, resolveDialect('luaU')).tokenize();

for (const t of tokens) {
  const typeName = TokenType[t.type];
  if (t.type === TokenType.InterpolatedStringLiteral) {
    console.log(`${typeName.padEnd(12)} parts=${JSON.stringify(t.parts)}`);
  } else {
    console.log(`${typeName.padEnd(12)} ${JSON.stringify(t.value)}`);
  }
}

console.log(`\nTotal ${tokens.length} tokens, continue keyword recognized: ${
  tokens.some(t => t.type === TokenType.Keyword && t.value === 'continue')
}, += recognized: ${
  tokens.some(t => t.type === TokenType.Punctuator && t.value === '+=')
}`);
