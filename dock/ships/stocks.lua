-- @ship   Stocks
-- @icon   star
-- @api    1
-- @version 1.0.0
-- Day chart for a ticker: close, 10-point and 20-point moving averages on a dot grid. OK fetches, Left and Right page
-- through your symbols. No data provider is built in: point it at any JSON endpoint (see SOURCE below).
--
-- Data source. Either edit SOURCE here, or store it with ship.stash (Harbor can write the ship's stash keys):
--   stash "src"      the URL template; {symbol} is replaced by the current symbol, e.g. https://example.com/q/{symbol}.json
--   stash "symbols"  comma list, e.g. AAPL,MSFT  (replaces the built-in list below; see docs/guides/STOCKS-DATA.md)
-- With no symbols set, the built-in Indian list is used (DEFAULT_SYMBOLS). There is still no default data source or key.
-- The endpoint must answer HTTP 200 with this JSON (any provider can be adapted with a tiny proxy or worker):
--   { "symbol": "ACME", "points": [ { "t": 1700000000, "close": 101.25 }, ... ] }
-- t is Unix seconds, oldest first; close is a number. Only the last 240 points are used.
local SOURCE = ""      -- e.g. "https://example.com/q/{symbol}.json"; wins over the stash when set
local SYMBOLS = ""     -- e.g. "ACME,BOLT"; wins over the stash when set
local DEFAULT_SYMBOLS = "^NSEI,^BSESN,RELIANCE.NS,TCS.NS,HDFCBANK.NS,INFY.NS,ICICIBANK.NS"  -- Nifty 50, Sensex, five large caps

local COLS, ROWS = 32, 24
local KEEP = 240

local idx = 1          -- current symbol
local data = {}        -- data[i] = { sym = string, t = {unix}, c = {close} }
local fetched = {}     -- fetched[i] = unix seconds of the last good fetch
local ago = ""         -- "updated N min ago", refreshed by update_ago (render stays a pure function of state)
local msg = ""         -- error or progress text
local busy = false

local cfg_src, cfg_syms = "", { "" }   -- read from the stash outside render (render must not touch the stash)

local function reload_config()
  cfg_src = SOURCE
  if cfg_src == "" then
    local s = ship.stash("src")
    cfg_src = (type(s) == "string") and s or ""
  end
  local list = SYMBOLS
  if list == "" then
    local s = ship.stash("symbols")
    list = (type(s) == "string") and s or ""
  end
  if list == "" then list = DEFAULT_SYMBOLS end
  cfg_syms = {}
  for sym in list:gmatch("[^,%s]+") do cfg_syms[#cfg_syms + 1] = sym end
  if #cfg_syms == 0 then cfg_syms[1] = "" end
end

local function source() return cfg_src end
local function symbols() return cfg_syms end

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

-- JSON text -> { sym, t = {}, c = {} } or nil, reason
local function read_points(text, want)
  local ok, doc = pcall(function() return (parse_value(text, 1, 0)) end)
  if not ok or type(doc) ~= "table" or type(doc.points) ~= "table" then return nil, "unexpected data" end
  local t, c = {}, {}
  for _, p in ipairs(doc.points) do
    local close = type(p) == "table" and tonumber(p.close) or nil
    if close then
      t[#t + 1] = tonumber(p.t) or 0
      c[#c + 1] = close
    end
  end
  if #c < 2 then return nil, "no data points" end
  while #c > KEEP do table.remove(t, 1); table.remove(c, 1) end
  local sym = type(doc.symbol) == "string" and doc.symbol or want
  return { sym = sym ~= "" and sym or "?", t = t, c = c }
end

-- Moving average over the last n points; nil until n points exist.
local function average(c, n)
  local out, sum = {}, 0
  for i = 1, #c do
    sum = sum + c[i]
    if i > n then sum = sum - c[i - n] end
    if i >= n then out[i] = sum / n end
  end
  return out
end

local function update_ago()
  local f = fetched[idx]
  if not f then ago = ""; return end
  local m = (ship.now() - f) // 60
  if m < 1 then ago = "updated just now"
  elseif m == 1 then ago = "updated 1 min ago"
  else ago = "updated " .. m .. " min ago" end
end

local function persist()
  ship.save({ idx = idx, fetched = fetched, msg = (msg ~= "Loading...") and msg or "" })
end

local function pack(d)
  local parts = { d.sym }
  for i = 1, #d.c do parts[#parts + 1] = d.t[i] .. " " .. d.c[i] end
  return table.concat(parts, "\n")
end

local function unpack_cache(text)
  local d = { t = {}, c = {} }
  local first = true
  for line in text:gmatch("[^\n]+") do
    if first then
      d.sym = line
      first = false
    else
      local t, c = line:match("^(%S+) (%S+)$")
      if tonumber(t) and tonumber(c) then
        d.t[#d.t + 1] = tonumber(t)
        d.c[#d.c + 1] = tonumber(c)
      end
    end
  end
  if #d.c < 2 or not d.sym then return nil end
  return d
end

local function load_cache(i)
  local raw = ship.stash("d" .. i)
  if type(raw) == "string" then data[i] = unpack_cache(raw) end
end

local function do_fetch()
  local src = source()
  local syms = symbols()
  local sym = syms[idx] or syms[1]
  -- symbols keep letters, digits . - _ and ^ (index symbols such as ^NSEI); ^ goes into the URL as %5E
  local clean = sym:gsub("[^%w%.%-_%^]", ""):gsub("%^", "%%5E")
  local url = src:gsub("{symbol}", (clean:gsub("%%", "%%%%")))
  local status, body, err = ship.fetch(url)
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
  local d, why = read_points(body, sym)
  if not d then
    msg = why
    persist()
    return
  end
  data[idx] = d
  fetched[idx] = ship.now()
  msg = ""
  ship.stash("d" .. idx, pack(d))
  persist()
  update_ago()
  ship.every(60000)
end

local function start_fetch()
  if busy or source() == "" then return end
  busy = true
  msg = "Loading..."
  ship.later(do_fetch)
end

function ship.launch()
  reload_config()
  local s = ship.restore()
  local n = #symbols()
  if s then
    msg = type(s.msg) == "string" and s.msg or ""
    idx = (type(s.idx) == "number" and s.idx >= 1 and s.idx <= n) and s.idx or 1
    if type(s.fetched) == "table" then
      for k, v in pairs(s.fetched) do fetched[tonumber(k) or 0] = v end
    end
  end
  for i = 1, n do load_cache(i) end
  update_ago()
  if next(fetched) then ship.every(60000) end   -- the "updated N min ago" line ticks only once there is data
end

function ship.press(key)
  local n = #symbols()
  if key == "ok" then
    reload_config()
    start_fetch()
  elseif key == "left" or key == "right" then
    idx = (idx - 1 + (key == "right" and 1 or -1)) % n + 1
    msg = ""
    update_ago()
    persist()
  end
end

function ship.pulse()
  update_ago()
end

local function hhmm(t)
  local d = ship.date(t)
  return string.format("%02d:%02d", d.hour, d.min)
end

local function money(v)
  return string.format("%.2f", v)
end

-- The chart: '#' close (a line, solid squares), 'o' 10-point average (dots), 'H' 20-point average (hollow-centre
-- squares), '.' the dot grid. Close wins where marks overlap.
local function chart_cells(d)
  local c = d.c
  local n = #c
  local hi, lo = c[1], c[1]
  for i = 2, n do
    if c[i] > hi then hi = c[i] end
    if c[i] < lo then lo = c[i] end
  end
  local ma10, ma20 = average(c, 10), average(c, 20)
  local cells = {}
  for i = 1, COLS * ROWS do cells[i] = "." end
  local function row(v)
    if hi == lo then return ROWS // 2 end
    local r = math.floor((hi - v) / (hi - lo) * (ROWS - 1) + 0.5)
    return r < 0 and 0 or (r > ROWS - 1 and ROWS - 1 or r)
  end
  local function at(col, i) return math.floor((col - 1) * (n - 1) / (COLS - 1)) + 1 end
  for col = 1, COLS do
    local i = at(col, 0)
    if ma20[i] then cells[row(ma20[i]) * COLS + col] = "H" end
  end
  for col = 1, COLS do
    local i = at(col, 0)
    if ma10[i] then cells[row(ma10[i]) * COLS + col] = "o" end
  end
  local prev
  for col = 1, COLS do
    local r = row(c[at(col, 0)])
    local from = prev or r
    local a, b = math.min(from, r), math.max(from, r)
    for y = a, b do cells[y * COLS + col] = "#" end
    prev = r
  end
  return table.concat(cells), hi, lo
end

function ship.render(ui)
  local d = data[idx]
  local syms = symbols()
  ui.align("center")
  if source() == "" then
    ui.heading("STOCKS")
    ui.space(20)
    ui.para("Set a data source in Harbor or edit stocks.lua")
    ui.hints{ "back" }
    return
  end
  ui.heading(d and d.sym or (syms[idx] ~= "" and syms[idx] or "STOCKS"))
  if d then
    local cells, hi, lo = chart_cells(d)
    ui.note("Day   last " .. hhmm(d.t[#d.t]) .. "   close " .. money(d.c[#d.c]))
    ui.note("High " .. money(hi) .. "   Low " .. money(lo))
    ui.note("# close   o MA10   H MA20")
    ui.space(4)
    ui.grid{ cols = COLS, rows = ROWS, cells = cells }
    if msg ~= "" then ui.status(msg)
    else ui.status(ago ~= "" and ago or "delayed ~15 min") end
  else
    ui.note("Day")
    ui.space(20)
    ui.para(msg ~= "" and msg or "Press OK to fetch")
    ui.status("delayed ~15 min")
  end
  ui.hints{ "back", "fetch", "< page", "page >" }
end

function ship.dock()
  persist()
end
