import { parse } from '../index';

const luauSample = `
type Handler = (msg: string) -> boolean

local function greet(name: string, opts: { verbose: boolean? }?): string
    local count = 0
    for i = 1, 3 do
        count += 1
        if i == 2 then
            continue
        end
        print(\`Hello {name}, iteration {i}!\`)
    end
    local x <const> = 42
    local result = if count > 0 then "positive" else "zero"
    local t = { 1, 2, name = "luau", [1 + 1] = "two" }
    return \`count=\` .. count
end

export type Point = { x: number, y: number }

local obj = {}
function obj:method(a, b, ...)
    return a + b
end
`;

console.log('=== luaU dialect ===');
try {
  const ast = parse(luauSample, 'luaU');
  console.log('OK, top-level statements:', ast.body.map(s => s.type));
} catch (e) {
  console.error('FAILED:', e);
  throw e;
}

const lua51Sample = `
local function fib(n)
    if n < 2 then
        return n
    end
    return fib(n - 1) + fib(n - 2)
end

local t = {}
for i = 1, 10 do
    t[i] = fib(i)
end

local function greet(name)
    print("hello, " .. name)
end
greet("world")
`;

console.log('\n=== lua5.1 dialect ===');
try {
  const ast = parse(lua51Sample, 'lua5.1');
  console.log('OK, top-level statements:', ast.body.map(s => s.type));
} catch (e) {
  console.error('FAILED:', e);
  throw e;
}

console.log('\n=== Checking that the lua5.1 dialect rejects Luau-only syntax ===');
const shouldFail = [
  ['local x <const> = 1', '<const> attribute'],
  ['local x: number = 1', 'type annotation'],
  ['x += 1', 'compound assignment'],
  ['local x = `hi {x}`', 'string interpolation'],
  ['::foo:: print(1)', 'label statement (not in 5.1 or Luau)'],
  ['goto foo', 'goto statement (not in 5.1 or Luau)'],
  ['while true do continue end', 'continue (should be allowed as an identifier — this one is expected to pass)'],
] as const;

for (const [code, label] of shouldFail) {
  try {
    parse(code, 'lua5.1');
    console.log(`  [${label}] passed (expected an error but got none -> may need a closer look): ${code}`);
  } catch (e) {
    console.log(`  [${label}] rejected as expected: ${(e as Error).message}`);
  }
}
