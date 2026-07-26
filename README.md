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
        { name: "EncryptNumbers" },
        { name: "WrapInFunction" },
    ],
    minify: true,
});

console.log(obfuscated);
```

## Features

| Feature                  | Description |
|--------------------------|-------------|
| InsertJunk               | Inserts meaningless junk statements |
| RenameVariables          | Renames variables to random strings |
| Vmify                    | Advanced custom VM (bytecode + interpreter) — core strength |
| ConstantArray            | Wraps constants into a randomized array |
| GlobalMapping            | Maps globals (`print`, `_G`, etc.) to a randomized table |
| StringsToExpressions     | Converts strings like `"abc"` into concatenated expressions |
| NumbersToExpressions     | Converts numbers into complex arithmetic expressions |
| EncryptStrings           | Encrypts strings using XOR |
| EncryptNumbers           | Encrypts numbers using XOR |
| WrapInFunction           | Wraps the entire script in an IIFE |