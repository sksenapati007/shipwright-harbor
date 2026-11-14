-- @ship   Coin
-- @icon   game
-- @api    1
-- @version 1.0.0
-- @art    coin_heads.sbm coin_tails.sbm coin_spin1.sbm coin_spin2.sbm coin_spin3.sbm
-- Toss a coin. OK tosses: the coin spins, then lands heads or tails. Left opens Decide mode, where you spell what heads
-- and tails mean (for example PIZZA and CURRY) so the answer reads as a decision. Right shows the last 10 tosses.
-- The coin is an original drawing in the style of a 1900 quarter anna. Randomness is ship.random (hardware RNG).

local SPIN = { "coin_spin1", "coin_spin2", "coin_spin3", "coin_spin2", "coin_spin1", "coin_spin2" }
local KEEP = 10                    -- tosses remembered
local LABEL_MAX = 14
local CHARS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-?!"

local heads, tails = 0, 0
local hist = ""                    -- last KEEP results, oldest first: "H" or "T"
local decide = false
local lab = { H = "", T = "" }
local last = nil                   -- "H", "T" or nil (not tossed yet)
local view = "main"                -- main, history, setup, edit
local spin = nil                   -- index into SPIN while the coin is in the air
local sel = 1                      -- setup row
local confirm = false              -- setup: reset asked once
local edit_side, edit_text, edit_ci = "H", "", 2

local function persist()
  ship.save({ heads = heads, tails = tails, hist = hist, decide = decide, lh = lab.H, lt = lab.T, last = last or "",
              view = view == "edit" and "setup" or view, sel = sel, confirm = confirm })
end

local function name(side)
  if decide and lab[side] ~= "" then return lab[side] end
  return side == "H" and "HEADS" or "TAILS"
end

local function toss()
  last = ship.random(2) == 1 and "H" or "T"
  if last == "H" then heads = heads + 1 else tails = tails + 1 end
  hist = (hist .. last):sub(-KEEP)
  spin = 1                         -- counted at the throw (saved when it lands, or by dock), so leaving mid-spin keeps it
  ship.every(250)
  ship.refresh("fast")
end

function ship.launch()
  local s = ship.restore()
  if type(s) == "table" then
    heads, tails = tonumber(s.heads) or 0, tonumber(s.tails) or 0
    hist = type(s.hist) == "string" and s.hist:sub(-KEEP) or ""
    decide = s.decide == true
    lab.H = type(s.lh) == "string" and s.lh:sub(1, LABEL_MAX) or ""
    lab.T = type(s.lt) == "string" and s.lt:sub(1, LABEL_MAX) or ""
    last = (s.last == "H" or s.last == "T") and s.last or nil
    if s.view == "setup" or s.view == "history" then view = s.view end
    sel = math.max(1, math.min(4, math.floor(tonumber(s.sel) or 1)))
    confirm = s.confirm == true
  end
end

function ship.pulse()
  if not spin then ship.every(0) return end
  spin = spin + 1
  if spin > #SPIN then
    spin = nil
    ship.every(0)
    persist()
    ship.refresh("clean")          -- the landed coin gets a full refresh so it is crisp
  else
    ship.refresh("fast")
  end
end

local function press_edit(key)
  if key == "left" then
    edit_ci = (edit_ci - 2) % #CHARS + 1
  elseif key == "right" then
    edit_ci = edit_ci % #CHARS + 1
  elseif key == "ok" then
    if #edit_text < LABEL_MAX then edit_text = edit_text .. CHARS:sub(edit_ci, edit_ci) end
  elseif key == "up" then
    edit_text = edit_text:sub(1, -2)
  elseif key == "down" then
    lab[edit_side] = edit_text:gsub("^%s+", ""):gsub("%s+$", "")
    persist()
    view = "setup"
  end
end

local function press_setup(key)
  if key == "left" then
    view, confirm = "main", false
  elseif key == "up" then
    sel, confirm = (sel - 2) % 4 + 1, false
  elseif key == "down" then
    sel, confirm = sel % 4 + 1, false
  elseif key == "right" then
    view, confirm = "history", false
  elseif key == "ok" then
    if sel == 1 then
      decide = not decide
      persist()
    elseif sel == 2 or sel == 3 then
      edit_side = sel == 2 and "H" or "T"
      edit_text, edit_ci = lab[edit_side], 2
      view = "edit"
    elseif confirm then
      heads, tails, hist, last, confirm = 0, 0, "", nil, false
      persist()
    else
      confirm = true
    end
  end
end

function ship.press(key)
  if spin then return end          -- the coin is in the air
  if view == "edit" then return press_edit(key) end
  if view == "setup" then return press_setup(key) end
  if view == "history" then
    view = "main"
    return
  end
  if key == "ok" then
    toss()
  elseif key == "left" then
    view = "setup"
  elseif key == "right" then
    view = "history"
  end
end

function ship.dock()
  persist()
end

local function render_main(ui)
  ui.align("center")
  ui.heading("COIN")
  if spin then
    ui.status("Tossing...")
    ui.picture(SPIN[spin])
    ui.hints{ "back" }
    return
  end
  ui.status("HEADS " .. heads .. "   TAILS " .. tails)
  if last then
    ui.picture(last == "H" and "coin_heads" or "coin_tails")
    ui.heading(last == "H" and "HEADS" or "TAILS")
    if decide and lab[last] ~= "" then ui.para(lab[last]) end
    ui.space(6)
    ui.note("OK tosses again")
  else
    ui.picture("coin_heads")
    ui.para(decide and (name("H") .. " or " .. name("T") .. "?") or "Heads or tails?")
    ui.note("Press OK to toss")
  end
  ui.hints{ "back", "toss", "decide", "history" }
end

local function render_history(ui)
  ui.heading("Last tosses")
  ui.status("HEADS " .. heads .. "   TAILS " .. tails)
  if hist == "" then
    ui.para("No tosses yet.")
  else
    for i = #hist, 1, -1 do
      local side = hist:sub(i, i)
      ui.item(name(side), { selected = i == #hist, value = (#hist - i + 1) .. (i == #hist and " latest" or "") })
    end
  end
  ui.hints{ "back", "toss" }
end

local function render_setup(ui)
  ui.heading("Decide mode")
  ui.para("Spell what heads and tails mean, then toss. The answer shows your words.")
  ui.space(8)
  ui.item("Decide mode", { selected = sel == 1, value = decide and "ON" or "OFF" })
  ui.item("Heads is", { selected = sel == 2, value = lab.H ~= "" and lab.H or "HEADS" })
  ui.item("Tails is", { selected = sel == 3, value = lab.T ~= "" and lab.T or "TAILS" })
  ui.item(confirm and "Press OK again to reset" or "Reset history", { selected = sel == 4 })
  ui.hints{ "back", "change", "toss", "history" }
end

local function render_edit(ui)
  ui.heading(edit_side == "H" and "Heads is" or "Tails is")
  ui.space(10)
  ui.align("center")
  ui.heading(edit_text .. "_")
  ui.space(10)
  local c = CHARS:sub(edit_ci, edit_ci)
  ui.para("Letter:  [ " .. (c == " " and "space" or c) .. " ]")
  ui.note("Left and right pick a letter, OK adds it.")
  ui.note("Up deletes, down saves.")
  ui.hints{ "back", "add", "prev", "next" }
end

function ship.render(ui)
  if view == "history" then return render_history(ui) end
  if view == "setup" then return render_setup(ui) end
  if view == "edit" then return render_edit(ui) end
  return render_main(ui)
end
