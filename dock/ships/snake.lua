-- @ship   Snake
-- @icon   snake
-- @api    1
-- @version 1.0.0
-- Classic Snake on a 16x20 dot-grid board. Arrows steer, OK starts, pauses and restarts, Back is the menu. The game is saved on exit and
-- comes back paused.

local W, H = 16, 20
local TICK = 400          -- ms per move (the pulse minimum is 250)
local DIRS = { up = { 0, -1 }, down = { 0, 1 }, left = { -1, 0 }, right = { 1, 0 } }

local mode = "ready"      -- ready, run, pause, over
local body = {}           -- cell indices (y * W + x), head first
local dx, dy = 1, 0       -- direction of the last move
local wx, wy = 1, 0       -- direction wanted for the next move
local food = 0
local score, best = 0, 0
local won = false

local function place_food()
  local taken, free = {}, {}
  for _, c in ipairs(body) do taken[c] = true end
  for c = 0, W * H - 1 do
    if not taken[c] then free[#free + 1] = c end
  end
  if #free == 0 then return false end
  food = free[math.random(#free)]
  return true
end

local function new_game(first)
  local cx, cy = W // 2, H // 2
  body = { cy * W + cx, cy * W + cx - 1, cy * W + cx - 2 }
  dx, dy, wx, wy = 1, 0, 1, 0
  score, won = 0, false
  if first then
    food = (cy - 3) * W + cx + 4   -- fixed first apple: launch runs before the random seed is set
  else
    place_food()
  end
end

local function persist()
  ship.save({ mode = mode, body = body, dx = dx, dy = dy, wx = wx, wy = wy, food = food,
              score = score, best = best, won = won })
end

local function finish(win)
  mode, won = "over", win
  if score > best then best = score end
  ship.every(0)
  persist()
end

local function step()
  dx, dy = wx, wy
  local head = body[1]
  local nx, ny = head % W + dx, head // W + dy
  if nx < 0 or nx >= W or ny < 0 or ny >= H then return finish(false) end
  local n = ny * W + nx
  local ate = n == food
  local last = #body - (ate and 0 or 1)   -- the tail cell is free again unless the snake grows
  for i = 1, last do
    if body[i] == n then return finish(false) end
  end
  table.insert(body, 1, n)
  if ate then
    score = score + 1
    if not place_food() then return finish(true) end
  else
    table.remove(body)
  end
end

function ship.launch()
  local s = ship.restore()
  if s and type(s.body) == "table" and #s.body > 0 then
    body, dx, dy, wx, wy = s.body, s.dx or 1, s.dy or 0, s.wx or 1, s.wy or 0
    food, score, best, won = s.food or 0, s.score or 0, s.best or 0, s.won or false
    mode = (s.mode == "over") and "over" or ((s.mode == "ready") and "ready" or "pause")
  else
    new_game(true)
  end
end

function ship.press(key)
  if key == "ok" then
    if mode == "ready" or mode == "pause" then
      mode = "run"
      ship.every(TICK)
    elseif mode == "run" then
      mode = "pause"
      ship.every(0)
      persist()
    else
      new_game()
      mode = "run"
      ship.every(TICK)
    end
    return
  end
  local d = DIRS[key]
  if d and mode == "run" and not (d[1] == -dx and d[2] == -dy) then
    wx, wy = d[1], d[2]
  end
end

function ship.pulse()
  if mode == "run" then step() end
end

local HEADING = { [1] = { [0] = "EAST" }, [-1] = { [0] = "WEST" }, [0] = { [1] = "SOUTH", [-1] = "NORTH" } }

function ship.render(ui)
  -- Cells: '.' dot-grid, '@' body square, 'H' head (hollow centre), 'O' round food.
  local cells = {}
  for i = 1, W * H do cells[i] = "." end
  cells[food + 1] = "O"
  for i = #body, 1, -1 do cells[body[i] + 1] = (i == 1) and "H" or "@" end
  ui.align("center")
  ui.heading("SNAKE")
  ui.note("SCORE " .. score .. "   BEST " .. best .. "   LEN " .. #body)
  ui.space(6)
  ui.grid{ cols = W, rows = H, cells = table.concat(cells) }
  if mode == "run" or mode == "ready" then
    ui.status("HEADING " .. HEADING[dx][dy])
  elseif mode == "pause" then
    ui.status("PAUSED")
  else
    ui.status(won and "YOU WIN" or "GAME OVER")
  end
  if mode == "run" then ui.hints{ "menu", "pause" }
  elseif mode == "over" then ui.hints{ "menu", "again" }
  elseif mode == "pause" then ui.hints{ "menu", "resume" }
  else ui.hints{ "menu", "start" } end
end

function ship.dock()
  persist()
end
