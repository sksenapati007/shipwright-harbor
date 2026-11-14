-- @ship   Blockfall
-- @icon   game
-- @api    1
-- @version 1.1.0
-- Falling-blocks puzzle on a 10x20 dot-grid well. Left and right move, Up turns, Down drops one row, OK drops the piece
-- all the way (OK starts and restarts), hold OK to pause. Full rows clear. The game is saved on exit and comes back paused.
-- Tilt (needs the tilt sensor): on the start, pause and game-over screens Up turns tilt control on or off. While it is
-- on, rolling the device left or right moves the piece, faster the further you roll; the keys keep working.

local W, H = 10, 20
local GC, GR = 16, 20            -- grid: the well, a gap column, then a five-column side panel for the next piece
local FLOOR = 250                -- the ship pulse floor in ms (ship.every clamps to 250..60000)

-- Seven four-cell pieces drawn in a square box (3x3, I in 4x4, O in 2x2); turning is a quarter turn of the box.
local DEFS = {
  { n = 4, "....", "####", "....", "...." },   -- I
  { n = 2, "##", "##" },                       -- O
  { n = 3, ".#.", "###", "..." },              -- T
  { n = 3, ".##", "##.", "..." },              -- S
  { n = 3, "##.", ".##", "..." },              -- Z
  { n = 3, "#..", "###", "..." },              -- J
  { n = 3, "..#", "###", "..." },              -- L
}

local SHAPES = {}                -- SHAPES[kind][rot + 1] = { {x, y} * 4 } relative to the box origin
for k, d in ipairs(DEFS) do
  local cur = {}
  for r = 1, d.n do
    for c = 1, d.n do
      if d[r]:sub(c, c) == "#" then cur[#cur + 1] = { c - 1, r - 1 } end
    end
  end
  SHAPES[k] = {}
  for rot = 1, 4 do
    SHAPES[k][rot] = cur
    local nxt = {}
    for i, p in ipairs(cur) do nxt[i] = { d.n - 1 - p[2], p[1] } end
    cur = nxt
  end
end

local LINE_SCORE = { 40, 100, 300, 1200 }
local KICKS = { 0, -1, 1, -2, 2 }

local mode = "ready"             -- ready, run, pause, over
local board = {}                 -- 200 cells, 0 empty or 1 filled, row by row
local kind, rot, px, py = 0, 0, 0, 0   -- the falling piece (kind 0: none yet)
local nextk = 0
local bag = {}
local score, lines, level, best = 0, 0, 1, 0
local tilt_ok = false            -- the device has a tilt sensor (found at launch)
local tilt_on = false            -- the player turned tilt control on (saved)
local tilt_pow = false           -- the sensor is powered: tilt on and a game running
local tacc, gacc = 0, 0          -- tilt step accumulator; gravity time accumulator (ms)
local TILT_GAIN = 1.25           -- columns per pulse at full tilt

local function empty_board()
  board = {}
  for i = 1, W * H do board[i] = 0 end
end

local function fits(k, r, x, y)
  for _, p in ipairs(SHAPES[k][r + 1]) do
    local cx, cy = x + p[1], y + p[2]
    if cx < 0 or cx >= W or cy >= H then return false end
    if cy >= 0 and board[cy * W + cx + 1] ~= 0 then return false end
  end
  return true
end

local function take()            -- seven-piece bag, so no long droughts
  if #bag == 0 then
    for i = 1, 7 do bag[i] = i end
    for i = 7, 2, -1 do
      local j = math.random(i)
      bag[i], bag[j] = bag[j], bag[i]
    end
  end
  return table.remove(bag)
end

local function interval()
  local ms = 800 - (level - 1) * 60
  return ms < FLOOR and FLOOR or ms
end

local function rate()            -- the pulse period: fast while tilt steers, so the piece can follow the roll
  return tilt_pow and FLOOR or interval()
end

local function sync_tilt()       -- power the sensor only while a game runs with tilt on
  local want = tilt_ok and tilt_on and mode == "run"
  if want ~= tilt_pow then
    tilt_pow = want
    ship.tilt_enable(want)
    tacc, gacc = 0, 0
    if mode == "run" then ship.every(rate()) end
  end
end

local function persist()
  ship.save({ tilt = tilt_on, mode = mode, board = table.concat(board), kind = kind, rot = rot, px = px, py = py, next = nextk,
              bag = bag, score = score, lines = lines, level = level, best = best })
end

local function finish()
  mode = "over"
  if score > best then best = score end
  ship.every(0)
  sync_tilt()
  persist()
  ship.log("game over score=" .. score .. " lines=" .. lines .. " level=" .. level)
end

local function spawn()
  kind, nextk = nextk, take()
  rot = 0
  px, py = (W - DEFS[kind].n) // 2, 0
  if not fits(kind, rot, px, py) then finish() end
end

local function new_game()
  empty_board()
  bag = {}
  score, lines, level = 0, 0, 1
  nextk = take()
  spawn()
  mode = "run"
  sync_tilt()
  ship.every(rate())
end

local function lock()
  for _, p in ipairs(SHAPES[kind][rot + 1]) do
    local cy = py + p[2]
    if cy >= 0 then board[cy * W + px + p[1] + 1] = 1 end
  end
  local cleared = 0
  local y = H - 1
  while y >= 0 do
    local full = true
    for x = 1, W do
      if board[y * W + x] == 0 then full = false; break end
    end
    if full then
      for yy = y, 1, -1 do
        for x = 1, W do board[yy * W + x] = board[(yy - 1) * W + x] end
      end
      for x = 1, W do board[x] = 0 end
      cleared = cleared + 1       -- same row again: the rows above moved down
    else
      y = y - 1
    end
  end
  if cleared > 0 then
    score = score + LINE_SCORE[cleared] * level
    lines = lines + cleared
    level = lines // 10 + 1
    ship.every(rate())
  end
  spawn()
end

local function step(bonus)       -- one row down; lock when it cannot move
  if fits(kind, rot, px, py + 1) then
    py = py + 1
    score = score + bonus
  else
    lock()
  end
end

local function turn()
  local nr = (rot + 1) % 4
  for _, dx in ipairs(KICKS) do
    if fits(kind, nr, px + dx, py) then
      rot, px = nr, px + dx
      return
    end
  end
end

function ship.launch()
  empty_board()
  local s = ship.restore()
  tilt_ok = ship.tilt_enable ~= nil and ship.tilt_enable(true)   -- probe: true only when the board has the sensor
  if tilt_ok then ship.tilt_enable(false) end
  tilt_on = tilt_ok and s ~= nil and s.tilt == true
  if s and type(s.board) == "string" and #s.board == W * H and (s.kind or 0) >= 1 and s.kind <= 7 then
    for i = 1, W * H do board[i] = (s.board:sub(i, i) == "1") and 1 or 0 end
    kind, rot, px, py = s.kind, (s.rot or 0) % 4, s.px or 3, s.py or 0
    nextk = (s.next and s.next >= 1 and s.next <= 7) and s.next or 1
    bag = type(s.bag) == "table" and s.bag or {}
    score, lines, level, best = s.score or 0, s.lines or 0, s.level or 1, s.best or 0
    mode = (s.mode == "over") and "over" or "pause"
  else
    best = s and s.best or 0
  end
end

function ship.press(key, held)
  if key == "ok" then
    if mode == "run" then
      if held then
        mode = "pause"
        ship.every(0)
        sync_tilt()
        persist()
        return
      end
      local n = 0
      while fits(kind, rot, px, py + 1) do py = py + 1; n = n + 1 end
      score = score + 2 * n
      lock()
    elseif mode == "pause" then
      mode = "run"
      sync_tilt()
      ship.every(rate())
    else
      new_game()
    end
    return
  end
  if mode ~= "run" then
    if key == "up" and tilt_ok then tilt_on = not tilt_on; persist() end
    return
  end
  if key == "left" and fits(kind, rot, px - 1, py) then
    px = px - 1
  elseif key == "right" and fits(kind, rot, px + 1, py) then
    px = px + 1
  elseif key == "up" then
    turn()
  elseif key == "down" then
    step(1)
  end
end

local function tilt_move()
  local x = ship.tilt()
  if not x or x == 0 then tacc = 0; return end
  if (x > 0) ~= (tacc > 0) then tacc = 0 end           -- turned the other way: start over
  tacc = tacc + x * TILT_GAIN
  local dir = tacc > 0 and 1 or -1
  while (tacc >= 1 or tacc <= -1) do
    tacc = tacc - dir
    if fits(kind, rot, px + dir, py) then px = px + dir else tacc = 0 end
  end
end

function ship.pulse()
  if mode ~= "run" then return end
  if not tilt_pow then step(0); return end
  tilt_move()
  gacc = gacc + FLOOR
  if gacc >= interval() then
    gacc = gacc - interval()
    step(0)
  end
end

function ship.render(ui)
  -- Cells: '.' dot-grid, '@' locked square, '#' falling piece. The side panel shows the next piece.
  local cells = {}
  for i = 1, GC * GR do cells[i] = " " end
  for y = 0, H - 1 do
    for x = 0, W - 1 do
      cells[y * GC + x + 1] = board[y * W + x + 1] ~= 0 and "@" or "."
    end
  end
  if kind > 0 and mode ~= "over" then
    for _, p in ipairs(SHAPES[kind][rot + 1]) do
      local cy = py + p[2]
      if cy >= 0 then cells[cy * GC + px + p[1] + 1] = "#" end
    end
  end
  if nextk > 0 then
    local d = DEFS[nextk]
    local ox = 11 + (4 - d.n) // 2
    for _, p in ipairs(SHAPES[nextk][1]) do
      cells[(1 + p[2]) * GC + ox + p[1] + 1] = "#"
    end
  end
  ui.align("center")
  ui.heading("BLOCKFALL")
  ui.note("SCORE " .. score .. "  LINES " .. lines .. "  LEVEL " .. level .. "  BEST " .. best)
  ui.space(6)
  ui.grid{ cols = GC, rows = GR, cells = table.concat(cells) }
  if mode == "over" then
    ui.status(tilt_ok and ("GAME OVER  UP TILT " .. (tilt_on and "ON" or "OFF")) or "GAME OVER")
  elseif mode == "pause" then
    ui.status(tilt_ok and ("PAUSED  UP TILT " .. (tilt_on and "ON" or "OFF")) or "PAUSED")
  elseif mode == "ready" then
    ui.status(tilt_ok and ("UP TILT " .. (tilt_on and "ON" or "OFF") .. "  HOLD OK PAUSE")
              or "UP TURN  DOWN SOFT  HOLD OK PAUSE")
  else
    ui.status(tilt_pow and "TILT STEERS  NEXT AT RIGHT" or "NEXT AT RIGHT")
  end
  if mode == "run" then ui.hints{ "menu", "drop", "left", "right" }
  elseif mode == "over" then ui.hints{ "menu", "again" }
  elseif mode == "pause" then ui.hints{ "menu", "resume" }
  else ui.hints{ "menu", "start" } end
end

function ship.dock()
  persist()
end
