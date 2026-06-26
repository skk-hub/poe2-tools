-- pob-bridge.lua — run Path of Building (PoE2) HEADLESS under luajit to compute
-- build stats / candidate-item deltas for the Gear Upgrade Finder.
--
-- SimpleGraphic host-API stubs are adapted from PathOfBuildingCommunity's
-- src/HeadlessWrapper.lua (MIT). Must be run with cwd = the PoB install folder
-- (so Launch.lua + Modules/* resolve), e.g.:
--   cd "<PoB folder>" && luajit "<repo>/pob-bridge.lua" --stats "<build.xml>"
--
-- Modes:
--   --stats <file>   one-shot: load build xml file, print stats JSON, exit (SPIKE)
--   --rpc            persistent: length-framed stdio protocol (see pob.js)

-- Capture our CLI args up front — PoB's Launch.lua clobbers the global `arg`.
local BRIDGE_MODE, BRIDGE_ARG2 = arg[1], arg[2]

-- ── SimpleGraphic stubs ────────────────────────────────────────────────────
local callbackTable = {}
local mainObject
function runCallback(name, ...)
	if callbackTable[name] then return callbackTable[name](...)
	elseif mainObject and mainObject[name] then return mainObject[name](mainObject, ...) end
end
function SetCallback(name, func) callbackTable[name] = func end
function GetCallback(name) return callbackTable[name] end
function SetMainObject(obj) mainObject = obj end

local imageHandleClass = {}
imageHandleClass.__index = imageHandleClass
function NewImageHandle() return setmetatable({}, imageHandleClass) end
function imageHandleClass:Load(fileName, ...) self.valid = true end
function imageHandleClass:Unload() self.valid = false end
function imageHandleClass:IsValid() return self.valid end
function imageHandleClass:SetLoadingPriority(pri) end
function imageHandleClass:ImageSize() return 1, 1 end

function RenderInit(flag, ...) end
function GetScreenSize() return 1920, 1080 end
function GetScreenScale() return 1 end
function GetDPIScaleOverridePercent() return 1 end
function SetDPIScaleOverridePercent(scale) end
function SetClearColor(r, g, b, a) end
function SetDrawLayer(layer, subLayer) end
function SetViewport(x, y, width, height) end
function SetDrawColor(r, g, b, a) end
function DrawImage(...) end
function DrawImageQuad(...) end
function DrawString(...) end
function DrawStringWidth(height, font, text) return 1 end
function DrawStringCursorIndex(height, font, text, cursorX, cursorY) return 0 end
function StripEscapes(text) return (text:gsub("%^%d", ""):gsub("%^x%x%x%x%x%x%x", "")) end
function GetAsyncCount() return 0 end
function NewFileSearch() end

function SetWindowTitle(title) end
function GetCursorPos() return 0, 0 end
function SetCursorPos(x, y) end
function ShowCursor(doShow) end
function IsKeyDown(keyName) end
function Copy(text) end
function Paste() end
function Deflate(data) return "" end
function Inflate(data) return "" end
function GetTime() return 0 end
function GetScriptPath() return "" end
function GetRuntimePath() return "" end
function GetUserPath() return "" end
function MakeDir(path) end
function RemoveDir(path) end
function SetWorkDir(path) end
function GetWorkDir() return "" end
function LaunchSubScript(scriptText, funcList, subList, ...) end
function AbortSubScript(ssID) end
function IsSubScriptRunning(ssID) end
function LoadModule(fileName, ...)
	if not fileName:match("%.lua") then fileName = fileName .. ".lua" end
	local func, err = loadfile(fileName)
	if func then return func(...) else error("LoadModule() error loading '" .. fileName .. "': " .. err) end
end
function PLoadModule(fileName, ...)
	if not fileName:match("%.lua") then fileName = fileName .. ".lua" end
	local func, err = loadfile(fileName)
	if func then return PCall(func, ...) else error("PLoadModule() error loading '" .. fileName .. "': " .. err) end
end
function PCall(func, ...)
	local ret = { pcall(func, ...) }
	if ret[1] then table.remove(ret, 1); return nil, unpack(ret) else return ret[2] end
end
function ConPrintf(fmt, ...) end   -- silenced: stdout is our protocol channel
function ConPrintTable(tbl, noRecurse) end
function ConExecute(cmd) end
function ConClear() end
function SpawnProcess(cmdName, args) end
function OpenURL(url) end
function SetProfiling(isEnabled) end
function Restart() end
function Exit() end
function TakeScreenshot() end
function GetCloudProvider(fullPath) return nil, nil, nil end

local l_require = require
function require(name)
	if name == "lcurl.safe" then return end
	return l_require(name)
end

-- ── Boot PoB ───────────────────────────────────────────────────────────────
-- PoB bundles its third-party Lua (xml, dkjson, base64, sha…) in <PoB>/lua/;
-- SimpleGraphic normally wires this into package.path, so do it ourselves.
package.path = "./lua/?.lua;./lua/?/init.lua;" .. package.path
dofile("Launch.lua")
mainObject.continuousIntegrationMode = os.getenv("CI")
runCallback("OnInit")
runCallback("OnFrame")
if mainObject.promptMsg then
	io.stderr:write("PoB startup error: " .. tostring(mainObject.promptMsg) .. "\n")
	os.exit(1)
end
local build = mainObject.main.modes["BUILD"]

local function loadBuildXML(xml)
	mainObject.main:SetMode("BUILD", false, "bridge", xml)
	runCallback("OnFrame")
	build = mainObject.main.modes["BUILD"]
	runCallback("OnFrame")
end

-- Pull the headline stats out of a calc output table (key names vary by version,
-- so probe a list and keep whatever is present).
local STAT_KEYS = { "FullDPS", "CombinedDPS", "TotalDPS", "TotalDotDPS", "AverageDamage",
	"Speed", "Life", "EnergyShield", "Mana", "TotalEHP", "Ward",
	"FireResist", "ColdResist", "LightningResist", "ChaosResist" }
local function getStatsFrom(out)
	local t = {}
	out = out or {}
	for _, k in ipairs(STAT_KEYS) do
		if type(out[k]) == "number" then t[k] = out[k] end
	end
	return t
end
local function getStats()
	return getStatsFrom(build and build.calcsTab and build.calcsTab.mainOutput)
end

-- Non-destructive what-if: compute the build's output with one item replaced in a
-- slot (PoB's own item-compare path via the misc calculator). itemText empty =
-- baseline (no swap).
local function calcWith(slotName, itemText)
	local calcFunc = build.calcsTab:GetMiscCalculator()
	if not calcFunc then return getStats() end
	local override = {}
	if itemText and itemText ~= "" then
		-- Build the Item and VALIDATE it has a recognised base BEFORE calcing. An
		-- item with no base (garbled copy / unknown base) makes the calc index a
		-- nil and crash mid-run, which poisons the persistent process so every
		-- later item fails too. Reject it cleanly instead.
		local ok0, item = pcall(new, "Item", itemText)
		if not ok0 or not item or not item.base then
			return nil, "no base type in the copy — include the item's name + base (e.g. 'Grim Gloves'), one item only"
		end
		override.repSlotName = slotName
		override.repItem = item
	end
	local ok, out = pcall(calcFunc, override)
	if not ok then return nil, tostring(out) end
	return getStatsFrom(out)
end

-- Combined what-if: equip SEVERAL items at once (one per slot) and recompute the
-- whole build, so the gain reflects compounding (the misc calculator only swaps one
-- slot). We use the SAME item parser (new("Item", …)) as calcWith, so the combined
-- number is consistent with the per-item scores. Items are equipped by id, stats
-- read, then everything is RESTORED so the persistent process stays clean.
-- payload: repeated "<slotName>\n<byteLen>\n<itemText>\n" blocks (byteLen frames the
-- item text so its own newlines are unambiguous).
local function calcMulti(payload)
	local itemsTab = build.itemsTab
	local saved, addedIds = {}, {}
	local function restore()
		for i = #saved, 1, -1 do saved[i].slot.selItemId = saved[i].prevId end
		for _, id in ipairs(addedIds) do
			local it = itemsTab.items[id]
			if it then pcall(function() itemsTab:DeleteItem(it) end) end
		end
		build.buildFlag = true
		runCallback("OnFrame")
	end
	local ok, res = pcall(function()
		local pos, n = 1, #payload
		while pos <= n do
			local nl1 = payload:find("\n", pos, true); if not nl1 then break end
			local slotName = payload:sub(pos, nl1 - 1); pos = nl1 + 1
			local nl2 = payload:find("\n", pos, true); if not nl2 then break end
			local len = tonumber(payload:sub(pos, nl2 - 1)); pos = nl2 + 1
			if not len then error("bad multi frame") end
			local itemText = payload:sub(pos, pos + len - 1); pos = pos + len + 1  -- +1 skips the trailing \n
			local slot = itemsTab.slots[slotName]
			if not slot then error("unknown slot: " .. slotName) end
			local ok0, item = pcall(new, "Item", itemText)
			if not ok0 or not item or not item.base then error("no base type in item for slot " .. slotName) end
			itemsTab:AddItem(item, true)            -- assigns item.id + BuildModList
			addedIds[#addedIds + 1] = item.id
			saved[#saved + 1] = { slot = slot, prevId = slot.selItemId }
			slot.selItemId = item.id
		end
		build.buildFlag = true
		runCallback("OnFrame")
		return getStats()
	end)
	restore()
	if ok then return res else return nil, tostring(res) end
end

-- minimal flat-table JSON (numbers/strings only) — no dep
local function jsonEncode(t)
	local parts = {}
	for k, v in pairs(t) do
		local val = type(v) == "number" and tostring(v) or ('"' .. tostring(v):gsub('"', '\\"') .. '"')
		parts[#parts + 1] = '"' .. k .. '":' .. val
	end
	return "{" .. table.concat(parts, ",") .. "}"
end

-- ── Modes ──────────────────────────────────────────────────────────────────
local mode = BRIDGE_MODE
if mode == "--stats" then
	local f = assert(io.open(BRIDGE_ARG2, "r"), "cannot open build file: " .. tostring(BRIDGE_ARG2))
	local xml = f:read("*a"); f:close()
	loadBuildXML(xml)
	io.write(jsonEncode(getStats()) .. "\n")
	os.exit(0)
end

-- --calc <buildfile> <slot> <itemfile>  : test a swap (base vs swapped stats)
if mode == "--calc" then
	local bf = assert(io.open(BRIDGE_ARG2, "r")); local xml = bf:read("*a"); bf:close()
	loadBuildXML(xml)
	local slot = arg[3]
	local itf = assert(io.open(arg[4], "r")); local itemText = itf:read("*a"); itf:close()
	io.write("base:    " .. jsonEncode(getStats()) .. "\n")
	local swapped, err = calcWith(slot, itemText)
	if swapped then io.write("swapped: " .. jsonEncode(swapped) .. "\n")
	else io.write("calc error: " .. tostring(err) .. "\n") end
	os.exit(0)
end

-- --rpc : persistent length-framed stdio server driven by pob.js.
--   request:  "<CMD> <nbytes>\n" + <nbytes payload>
--     LOAD payload=build xml        -> base stats
--     CALC payload="<slot>\n<item>" -> stats with that item swapped in
--     PING / QUIT
--   response: "OK <nbytes>\n<json>"  or  "ERR <nbytes>\n<msg>"
if mode == "--rpc" then
	io.stdout:setvbuf("no")
	local function reply(tag, body)
		body = body or ""
		io.write(tag .. " " .. #body .. "\n" .. body)
		io.flush()
	end
	reply("READY", "")   -- sync sentinel: pob.js ignores any boot stdout until this
	while true do
		local header = io.read("*l")
		if not header then break end
		local cmd, n = header:match("^(%u+)%s+(%d+)")
		if not cmd then reply("ERR", "bad header") else
			local payload = tonumber(n) > 0 and io.read(tonumber(n)) or ""
			if cmd == "QUIT" then break
			elseif cmd == "PING" then reply("OK", "pong")
			elseif cmd == "LOAD" then
				local ok, err = pcall(loadBuildXML, payload)
				if ok then reply("OK", jsonEncode(getStats())) else reply("ERR", tostring(err)) end
			elseif cmd == "CALC" then
				local slot, itemText = payload:match("^([^\n]*)\n(.*)$")
				local stats, err = calcWith(slot or "", itemText or "")
				if stats then reply("OK", jsonEncode(stats)) else reply("ERR", tostring(err)) end
			elseif cmd == "CALCM" then
				local stats, err = calcMulti(payload)
				if stats then reply("OK", jsonEncode(stats)) else reply("ERR", tostring(err)) end
			else reply("ERR", "unknown cmd " .. cmd) end
		end
	end
	os.exit(0)
end

io.stderr:write("pob-bridge: unknown mode " .. tostring(mode) .. "\n")
os.exit(2)
