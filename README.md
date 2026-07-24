# lua-obfuscator

A powerful Lua / Luau obfuscator with VM-based protection.

`lua-obfuscator` is a modern, high-quality obfuscation tool designed for Lua and Luau (especially for Roblox, FiveM, and standalone Lua projects). It features a custom VM (Vmify) to significantly raise reverse engineering difficulty.

---

## Installation

```bash
npm install lua-obfuscator
# or
yarn add lua-obfuscator
```

## Usage

```ts
import { obfuscate } from 'lua-obfuscator';

const source = `
    local function factorial(n)
        if n <= 1 then return 1 end
        return n * factorial(n - 1)
    end

    print(factorial(10))
`;

const obfuscated = obfuscate(source, "luaU", {
    steps: [
        { name: "InsertJunk" },
        { name: "RenameVariables" },
        { name: "Vmify" },
        { name: "ConstantArray" },
        { name: "GlobalMapping" },
        { name: "StringsToExpressions" },
        { name: "NumbersToExpressions" },
        { name: "EncryptStrings" },
        { name: "WrapInFunction" },
    ],
    minify: true,
});

console.log(obfuscated);
```

## Features
| Feature | Description |
| InsertJunk | Insert Junk Statements |
| RenameVariables | Rename Variables To random String |
| Vmify | Advanced custom VM (bytecode + interpreter) — the core strength |
| ConstantArray | Constant Array |
| GlobalMapping | Maps Globals (such as print, _G) to a {[randomId]=Global} table |
| StringsToExpressions | Make Strings Such as "abc" to "a" .. "b" .. "c" |
| NumbersToExpressions | Make Numbers Such as 1 to 3 + 200 - 202 |
| EncryptStrings | Encrypt Strings With XOR |
| WrapInFunction | Wraps The Whole Codes in a IIFE |