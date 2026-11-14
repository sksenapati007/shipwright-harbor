-- @ship   Analytics
-- @icon   star
-- @api    1
-- @version 1.0.0
-- Chart of one numeric series from a JSON URL you configure: a line of filled squares on a dot grid, with min, max and
-- last labels and an "updated N min ago" line. OK fetches. No URL is built in.
--
-- Data source. Either edit URL here, or store it with ship.stash (Harbor can write the ship's stash keys):
--   stash "url"   the address of the JSON, e.g. https://example.com/metrics/signups.json
-- The endpoint must answer HTTP 200 with this JSON:
--   { "title": "Signups", "points": [ { "t": 1700000000, "v": 12.5 }, ... ] }
-- t is Unix seconds, oldest first (optional); v is a number. Only the last 240 points are used.
local URL = ""        -- e.g. "https://example.com/metrics/signups.json"; wins over the stash when set

local COLS, ROWS = 32, 24
local KEEP = 240

local d = nil          -- { title, t = {}, v = {} }
local fetched = nil    -- unix seconds of the last good fetch
local ago = ""
local msg = ""
local busy = false
local cfg_url = ""     -- read from the stash outside render (render must not touch the stash)

local function reload_config()
  cfg_url = URL
  if cfg_url == "" then
    local s = ship.stash("url")
    cfg_url = (type(s) == "string") and s or ""
  end
end

-- Small JSON reader: enough for the documented shape and tolerant of anything else (returns nil, err).
local function skip(s, i)
  return s:find("[^ \t\r\n]", i) or #s + 1
end

local parse_value

local function parse_string(s, i)
  local out, j = {}, i + 1
  while true do
    local k = s:find('["\\]', j)
    if not k then error("unterminated string") end
    out[#out + 1] = s:sub(j, k - 1)
    if s:sub(k, k) == '"' then return table.concat(out), k + 1 end
    local e = s:sub(k + 1, k + 1)
    local map = { n = "\n", t = "\t", r = "\r", b = "\b", f = "\f" }
    if e == "u" then
      out[#out + 1] = "?"
      j = k + 6
    else
      out[#out + 1] = map[e] or e
      j = k + 2
    end
  end
end

function parse_value(s, i, depth)
  if depth > 6 then error("too deep") end
  i = skip(s, i)
  local c = s:sub(i, i)
  if c == "{" then
    local t = {}
    i = skip(s, i + 1)
    if s:sub(i, i) == "}" then return t, i + 1 end
    while true do
      i = skip(s, i)
      if s:sub(i, i) ~= '"' then error("object key expected") end
      local k
      k, i = parse_string(s, i)
      i = skip(s, i)
      if s:sub(i, i) ~= ":" then error("colon expected") end
      t[k], i = parse_value(s, i + 1, depth + 1)
      i = skip(s, i)
      local d = s:sub(i, i)
      i = i + 1
      if d == "}" then return t, i end
      if d ~= "," then error("comma expected") end
    end
  elseif c == "[" then
    local t, n = {}, 0
    i = skip(s, i + 1)
    if s:sub(i, i) == "]" then return t, i + 1 end
    while true do
      local v
      v, i = parse_value(s, i, depth + 1)
      n = n + 1
      t[n] = v
      i = skip(s, i)
      local d = s:sub(i, i)
      i = i + 1
      if d == "]" then return t, i end
      if d ~= "," then error("comma expected") end
    end
  elseif c == '"' then
    return parse_string(s, i)
  elseif s:find("^true", i) then
    return true, i + 4
  elseif s:find("^false", i) then
    return false, i + 5
  elseif s:find("^null", i) then
    return nil, i + 4
  end
  local num = s:match("^-?%d+%.?%d*[eE]?[+-]?%d*", i)
  if not num or num == "" or not tonumber(num) then error("bad value") end
  return tonumber(num), i + #num
end

-- JSON text -> { title, t, v } or nil, reason. Only the "points" array is parsed, one element at a time and
-- reduced to t and v, so a large document never becomes one big table.
-- ponytail: finds the first "points" key by text search (it can match inside a string), a streaming parser would not.
local function read_points(text)
  local at = select(2, text:find('"points"%s*:%s*%['))
  if not at then return nil, "unexpected data" end
  local t, v = {}, {}
  local i = skip(text, at + 1)
  local ok = pcall(function()
    while text:sub(i, i) ~= "]" do
      local p
      p, i = parse_value(text, i, 1)
      local val = type(p) == "table" and tonumber(p.v) or nil
      if val then
        t[#t + 1] = tonumber(p.t) or 0
        v[#v + 1] = val
        if #v > KEEP then table.remove(t, 1); table.remove(v, 1) end
      end
      i = skip(text, i)
      local d = text:sub(i, i)
      if d == "," then i = skip(text, i + 1) elseif d ~= "]" then error("comma expected") end
    end
  end)
  if not ok and #v < 2 then return nil, "unexpected data" end
  if #v < 2 then return nil, "no data points" end
  local title = text:match('"title"%s*:%s*"([^"\\]*)"') or ""
  return { title = title ~= "" and title or "ANALYTICS", t = t, v = v }
end

local function update_ago()
  if not fetched then ago = ""; return end
  local m = (ship.now() - fetched) // 60
  if m < 1 then ago = "updated just now"
  elseif m == 1 then ago = "updated 1 min ago"
  else ago = "updated " .. m .. " min ago" end
end

local function persist()
  ship.save({ fetched = fetched, msg = (msg ~= "Loading...") and msg or "" })
end

local function pack(x)
  local parts = { x.title }
  for i = 1, #x.v do parts[#parts + 1] = x.t[i] .. " " .. x.v[i] end
  return table.concat(parts, "\n")
end

local function unpack_cache(text)
  local x = { t = {}, v = {} }
  local first = true
  for line in text:gmatch("[^\n]+") do
    if first then
      x.title = line
      first = false
    else
      local t, v = line:match("^(%S+) (%S+)$")
      if tonumber(t) and tonumber(v) then
        x.t[#x.t + 1] = tonumber(t)
        x.v[#x.v + 1] = tonumber(v)
      end
    end
  end
  if #x.v < 2 or not x.title then return nil end
  return x
end

local function do_fetch()
  local status, body, err = ship.fetch(cfg_url)
  busy = false
  if not status then
    msg = "offline: " .. tostring(err)
    persist()
    return
  end
  if status ~= 200 then
    msg = "server answered " .. status
    persist()
    return
  end
  local x, why = read_points(body)
  if not x then
    msg = why
    persist()
    return
  end
  d = x
  fetched = ship.now()
  msg = ""
  ship.stash("d", pack(x))
  persist()
  update_ago()
  ship.every(60000)
end

function ship.launch()
  reload_config()
  local s = ship.restore()
  if s then
    msg = type(s.msg) == "string" and s.msg or ""
    fetched = type(s.fetched) == "number" and s.fetched or nil
  end
  local raw = ship.stash("d")
  if type(raw) == "string" then d = unpack_cache(raw) end
  if not d then fetched = nil end
  update_ago()
  if fetched then ship.every(60000) end   -- the "updated N min ago" line ticks only once there is data
end

function ship.press(key)
  if key == "ok" then
    reload_config()
    if busy or cfg_url == "" then return end
    busy = true
    msg = "Loading..."
    ship.later(do_fetch)
  end
end

function ship.pulse()
  update_ago()
end

local function num(x)
  if x == math.floor(x) and math.abs(x) < 1e9 then return string.format("%d", x) end
  return string.format("%.2f", x)
end

-- The chart: '#' the series (a line, solid squares), '.' the dot grid.
local function chart_cells(x)
  local v = x.v
  local n = #v
  local hi, lo = v[1], v[1]
  for i = 2, n do
    if v[i] > hi then hi = v[i] end
    if v[i] < lo then lo = v[i] end
  end
  local cells = {}
  for i = 1, COLS * ROWS do cells[i] = "." end
  local function row(val)
    if hi == lo then return ROWS // 2 end
    local r = math.floor((hi - val) / (hi - lo) * (ROWS - 1) + 0.5)
    return r < 0 and 0 or (r > ROWS - 1 and ROWS - 1 or r)
  end
  local prev
  for col = 1, COLS do
    local r = row(v[math.floor((col - 1) * (n - 1) / (COLS - 1)) + 1])
    local from = prev or r
    for y = math.min(from, r), math.max(from, r) do cells[y * COLS + col] = "#" end
    prev = r
  end
  return table.concat(cells), hi, lo
end

function ship.render(ui)
  ui.align("center")
  if cfg_url == "" then
    ui.heading("ANALYTICS")
    ui.space(20)
    ui.para("Set a data URL in Harbor or edit analytics.lua")
    ui.hints{ "back" }
    return
  end
  ui.heading(d and d.title or "ANALYTICS")
  if d then
    local cells, hi, lo = chart_cells(d)
    ui.note("Last " .. num(d.v[#d.v]))
    ui.note("Max " .. num(hi) .. "   Min " .. num(lo))
    ui.space(4)
    ui.grid{ cols = COLS, rows = ROWS, cells = cells }
    ui.status(msg ~= "" and msg or ago)
  else
    ui.space(20)
    ui.para(msg ~= "" and msg or "Press OK to fetch")
  end
  ui.hints{ "back", "fetch" }
end

function ship.dock()
  persist()
end
