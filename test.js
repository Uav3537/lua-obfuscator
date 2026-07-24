import assert from "node:assert/strict";
import * as esm from "./dist/index.js";
import * as cjs from "./dist/index.cjs";

// NOTE: this assumes a dual ESM/CJS build (dist/index.mjs + dist/index.js),
// same as the vigor project this was modeled after. Adjust the import paths
// above if this package only ships one of the two.
const { obfuscate, parse, LexError, ParseError, UnknownDialectError } = esm;

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`- ✅ ${name}`);
        passed++;
    } catch (err) {
        console.error(`- ❌ ${name}`);
        console.error(err);
        failed++;
    }
}

await test("ESM module exports are non-empty", async () => {
    assert.ok(Object.keys(esm).length > 0, "ESM export object is empty");
});

await test("CJS module exports are non-empty", async () => {
    assert.ok(Object.keys(cjs).length > 0, "CJS export object is empty");
});

await test("obfuscate() returns non-empty output for plain Lua 5.1", async () => {
    const out = obfuscate(`local x = 1\nprint(x)`, "lua5.1", { steps: [] });

    assert.equal(typeof out, "string", "obfuscate() did not return a string");
    assert.ok(out.length > 0, "obfuscate() returned an empty string");
});

await test("obfuscate() strips Luau type annotations entirely, even without Vmify", async () => {
    const src = `
        type Foo<T> = { x: T }
        export type Bar = number

        local function add(a: number, b: number, ...: string): (number, boolean)
            local x: Foo<number> = { x = 1 }
            return a + b, true
        end
    `;

    // Deliberately no 'Vmify' step: type stripping must not depend on it.
    const out = obfuscate(src, "luaU", { steps: [{ name: "RenameVariables" }] });

    assert.ok(!out.includes("type "), "output still contains a 'type' alias declaration");
    assert.ok(!out.includes("Foo"), "output still references the Luau type name 'Foo'");
    assert.ok(!out.includes("Bar"), "output still references the Luau type name 'Bar'");
    assert.ok(!/:\s*number/.test(out), "output still contains a ': number' type annotation");
});

await test("obfuscate() strips Luau type-cast expressions (`expr :: T`)", async () => {
    const src = `
        local a, b = 1, 2
        local y = (a + b) :: number
        local z = a :: any :: string
        print(y, z)
    `;

    const out = obfuscate(src, "luaU", { steps: [] });

    assert.ok(!out.includes("::"), "output still contains a '::' type-cast operator");
});

await test("obfuscate() rejects Luau-only syntax under the lua5.1 dialect", async () => {
    assert.throws(
        () => obfuscate(`local x: number = 1`, "lua5.1", { steps: [] }),
        (err) => {
            assert.ok(err instanceof ParseError, "error is not a ParseError");
            return true;
        }
    );
});

await test("obfuscate() throws UnknownDialectError for an unrecognized dialect", async () => {
    assert.throws(
        () => obfuscate(`print(1)`, "not-a-real-dialect", { steps: [] }),
        (err) => {
            assert.ok(err instanceof UnknownDialectError, "error is not an UnknownDialectError");
            return true;
        }
    );
});

await test("parse() throws LexError on an unterminated long string", async () => {
    assert.throws(
        () => parse(`local x = [[unterminated`, "luaU"),
        (err) => {
            assert.ok(err instanceof LexError, "error is not a LexError");
            return true;
        }
    );
});

await test("full pipeline (all steps, minified) survives a real-world Roblox script", async () => {
    const luasource = `
local Players = game:GetService("Players")
local TweenService = game:GetService("TweenService")

local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")

local oldGui = playerGui:FindFirstChild("VMifyAdvancedTest")

if oldGui then
    oldGui:Destroy()
end

local state = {
    clicks = 0,
    spawned = 0,
    running = true,
    messages = {},
}

local function addMessage(message)
    table.insert(state.messages, message)
end

local function getStatus()
    return string.format(
        "Clicks: %d | Objects: %d | Messages: %d",
        state.clicks,
        state.spawned,
        #state.messages
    )
end

local gui = Instance.new("ScreenGui")
gui.Name = "VMifyAdvancedTest"
gui.ResetOnSpawn = false
gui.Parent = playerGui

local main = Instance.new("Frame")
main.Name = "Main"
main.Size = UDim2.fromOffset(500, 400)
main.Position = UDim2.fromScale(0.5, 0.5)
main.AnchorPoint = Vector2.new(0.5, 0.5)
main.BackgroundColor3 = Color3.fromRGB(25, 25, 30)
main.BorderSizePixel = 0
main.Parent = gui

local mainCorner = Instance.new("UICorner")
mainCorner.CornerRadius = UDim.new(0, 14)
mainCorner.Parent = main

local title = Instance.new("TextLabel")
title.Size = UDim2.new(1, -40, 0, 45)
title.Position = UDim2.fromOffset(20, 15)
title.BackgroundTransparency = 1
title.Text = "VMify Advanced Roblox Test"
title.TextColor3 = Color3.new(1, 1, 1)
title.TextSize = 24
title.Font = Enum.Font.GothamBold
title.Parent = main

local status = Instance.new("TextLabel")
status.Size = UDim2.new(1, -40, 0, 35)
status.Position = UDim2.fromOffset(20, 65)
status.BackgroundTransparency = 1
status.Text = getStatus()
status.TextColor3 = Color3.fromRGB(180, 180, 190)
status.TextSize = 16
status.Font = Enum.Font.Gotham
status.Parent = main

local function refreshStatus()
    status.Text = getStatus()
end

local input = Instance.new("TextBox")
input.Size = UDim2.new(1, -40, 0, 45)
input.Position = UDim2.fromOffset(20, 110)
input.BackgroundColor3 = Color3.fromRGB(40, 40, 48)
input.BorderSizePixel = 0
input.PlaceholderText = "Type something..."
input.Text = ""
input.TextColor3 = Color3.new(1, 1, 1)
input.PlaceholderColor3 = Color3.fromRGB(140, 140, 150)
input.TextSize = 16
input.Font = Enum.Font.Gotham
input.ClearTextOnFocus = false
input.Parent = main

local inputCorner = Instance.new("UICorner")
inputCorner.CornerRadius = UDim.new(0, 8)
inputCorner.Parent = input

local container = Instance.new("Frame")
container.Size = UDim2.new(1, -40, 0, 80)
container.Position = UDim2.fromOffset(20, 165)
container.BackgroundColor3 = Color3.fromRGB(35, 35, 42)
container.BorderSizePixel = 0
container.Parent = main

local containerCorner = Instance.new("UICorner")
containerCorner.CornerRadius = UDim.new(0, 8)
containerCorner.Parent = container

local function createButton(text, position, callback)
    local button = Instance.new("TextButton")

    button.Size = UDim2.fromOffset(140, 45)
    button.Position = position
    button.BackgroundColor3 = Color3.fromRGB(65, 100, 220)
    button.BorderSizePixel = 0
    button.Text = text
    button.TextColor3 = Color3.new(1, 1, 1)
    button.TextSize = 15
    button.Font = Enum.Font.GothamBold
    button.AutoButtonColor = false
    button.Parent = main

    local corner = Instance.new("UICorner")
    corner.CornerRadius = UDim.new(0, 8)
    corner.Parent = button

    button.MouseEnter:Connect(function()
        local tween = TweenService:Create(
            button,
            TweenInfo.new(0.15),
            {
                BackgroundColor3 = Color3.fromRGB(90, 130, 255)
            }
        )

        tween:Play()
    end)

    button.MouseLeave:Connect(function()
        local tween = TweenService:Create(
            button,
            TweenInfo.new(0.15),
            {
                BackgroundColor3 = Color3.fromRGB(65, 100, 220)
            }
        )

        tween:Play()
    end)

    button.MouseButton1Click:Connect(callback)

    return button
end

local addButton = createButton(
    "Add Object",
    UDim2.fromOffset(20, 265),
    function()
        state.clicks += 1
        state.spawned += 1

        local object = Instance.new("TextLabel")
        object.Name = "DynamicObject_" .. state.spawned
        object.Size = UDim2.fromOffset(80, 55)
        object.Position = UDim2.fromOffset(
            10 + ((state.spawned - 1) % 5) * 90,
            12
        )
        object.BackgroundColor3 = Color3.fromRGB(
            50 + state.spawned * 10,
            70,
            150
        )
        object.Text = tostring(state.spawned)
        object.TextColor3 = Color3.new(1, 1, 1)
        object.TextSize = 20
        object.Font = Enum.Font.GothamBold
        object.Parent = container

        local corner = Instance.new("UICorner")
        corner.CornerRadius = UDim.new(0, 6)
        corner.Parent = object

        object.Size = UDim2.fromOffset(0, 0)

        local tween = TweenService:Create(
            object,
            TweenInfo.new(
                0.3,
                Enum.EasingStyle.Back,
                Enum.EasingDirection.Out
            ),
            {
                Size = UDim2.fromOffset(80, 55)
            }
        )

        tween:Play()

        addMessage("Created object " .. state.spawned)

        refreshStatus()
    end
)

local removeButton = createButton(
    "Clear Objects",
    UDim2.fromOffset(180, 265),
    function()
        state.clicks += 1

        for _, child in ipairs(container:GetChildren()) do
            if child:IsA("TextLabel") then
                child:Destroy()
            end
        end

        state.spawned = 0

        addMessage("Cleared objects")

        refreshStatus()
    end
)

local submitButton = createButton(
    "Submit",
    UDim2.fromOffset(340, 265),
    function()
        state.clicks += 1

        local text = input.Text

        if text == "" then
            addMessage("Empty input")
        else
            addMessage("Input: " .. text)
            input.Text = ""
        end

        refreshStatus()
    end
)

local logLabel = Instance.new("TextLabel")
logLabel.Size = UDim2.new(1, -40, 0, 35)
logLabel.Position = UDim2.fromOffset(20, 320)
logLabel.BackgroundTransparency = 1
logLabel.Text = "System ready..."
logLabel.TextColor3 = Color3.fromRGB(120, 220, 150)
logLabel.TextSize = 15
logLabel.Font = Enum.Font.Gotham
logLabel.Parent = main

input.FocusLost:Connect(function(enterPressed)
    if enterPressed then
        state.clicks += 1

        if input.Text ~= "" then
            addMessage("Enter: " .. input.Text)
            logLabel.Text = "Submitted: " .. input.Text
            input.Text = ""
        end

        refreshStatus()
    end
end)

task.spawn(function()
    while state.running do
        task.wait(1)

        if #state.messages > 0 then
            logLabel.Text = state.messages[#state.messages]
        else
            logLabel.Text = "System ready..."
        end
    end
end)

main.Size = UDim2.fromOffset(0, 0)

local openTween = TweenService:Create(
    main,
    TweenInfo.new(
        0.5,
        Enum.EasingStyle.Back,
        Enum.EasingDirection.Out
    ),
    {
        Size = UDim2.fromOffset(500, 400)
    }
)

openTween:Play()

print("================================")
print("VMIFY ADVANCED GUI TEST: PASS")
print("GUI created successfully")
print("Events connected successfully")
print("Tween system initialized")
print("Closure state initialized")
print("Dynamic object system initialized")
print("Async task initialized")
print("================================")
`;

    const out = obfuscate(luasource, "luaU", {
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

    assert.equal(typeof out, "string", "obfuscate() did not return a string");
    assert.ok(out.length > 0, "obfuscate() returned an empty string");
    assert.ok(out.startsWith("return (function"), "WrapInFunction did not wrap the output in a function call");
});

await test("CJS build's obfuscate() produces the same output as ESM's (no-op pipeline)", async () => {
    const src = `local x = 1\nlocal y = 2\nprint(x + y)`;
    const esmOut = esm.obfuscate(src, "lua5.1", { steps: [] });
    const cjsOut = cjs.obfuscate(src, "lua5.1", { steps: [] });

    assert.equal(cjsOut, esmOut, "CJS and ESM builds produced different output for an identical, deterministic pipeline");
});

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
    throw new Error(`${failed} test(s) failed`);
}