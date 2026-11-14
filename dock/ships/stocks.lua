-- @ship   Stocks
-- @icon   star
-- @api    1
-- @version 2.0.0
-- Indian markets by sector: a list per group (Indices, NSE sectors, BSE sectors, Stocks, and My list) and a day chart
-- (close, 10-point and 20-point moving averages on a dot grid) for the symbol you pick.
--
-- Keys. List view: Up and Down pick a row, Left and Right change group, OK opens the chart of the picked row
-- (on a group with no data yet, OK loads it). Chart view: OK fetches the symbol again, Left and Right go to the previous
-- and next symbol of the group, Up or Down returns to the list. Back leaves the ship.
--
-- Data. The default is Yahoo's public chart endpoint: no key, unofficial, may change or be rate-limited, for personal
-- use (see docs/guides/STOCKS-DATA.md). The ship fetches only the symbols of the group on screen, one request at a time,
-- when you open or change a group, and then at most once a minute while it stays open. Nothing runs in the background.
-- Override the source either by editing SOURCE below or with these ship.stash keys (Harbor can write them):
--   stash "src"      URL template; {symbol} is replaced by the current symbol, e.g. https://example.com/q/{symbol}.json
--   stash "symbols"  comma list, e.g. AAPL,MSFT; shown as its own group "My list" after the built-in groups
-- The endpoint must answer HTTP 200 with either Yahoo's chart JSON
--   { "chart": { "result": [ { "meta": { "longName": ".." }, "timestamp": [..], "indicators": { "quote": [ { "close": [..] } ] } } ] } }
-- (null closes are skipped; an error answer shows "no data for <symbol>") or this simple shape
--   { "symbol": "ACME", "points": [ { "t": 1700000000, "close": 101.25 }, ... ] }
-- t is Unix seconds, oldest first; close is a number. Only the last 240 points are used.
local SOURCE = ""      -- e.g. "https://example.com/q/{symbol}.json"; wins over the stash when set
local SYMBOLS = ""     -- e.g. "ACME,BOLT"; wins over the stash when set
local DEFAULT_SOURCE = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=5m&range=1d"

-- Built-in groups: { symbol, short name } pairs (names must fit one list row on the 480 px screen).
local GROUPS = {
  { name = "Indices", syms = { { "^NSEI", "Nifty 50" }, { "^BSESN", "Sensex" } } },
  { name = "NSE sectors", syms = {
    { "^NSEBANK", "Nifty Bank" }, { "^CNXIT", "Nifty IT" }, { "^CNXAUTO", "Nifty Auto" },
    { "^CNXPHARMA", "Nifty Pharma" }, { "^CNXFMCG", "Nifty FMCG" }, { "^CNXMETAL", "Nifty Metal" },
    { "^CNXENERGY", "Nifty Energy" }, { "^CNXREALTY", "Nifty Realty" }, { "^CNXMEDIA", "Nifty Media" },
    { "^CNXPSUBANK", "PSU Bank" }, { "NIFTY_FIN_SERVICE.NS", "Fin Services" } } },
  { name = "BSE sectors", syms = {
    { "BSE-BANK.BO", "BSE Bankex" }, { "BSE-IT.BO", "BSE IT" }, { "BSE-AUTO.BO", "BSE Auto" },
    { "BSE-HC.BO", "BSE Health" }, { "BSE-METAL.BO", "BSE Metal" }, { "BSE-OILGAS.BO", "BSE Oil Gas" },
    { "BSE-REALTY.BO", "BSE Realty" }, { "BSE-POWER.BO", "BSE Power" }, { "BSE-CG.BO", "BSE Cap Goods" },
    { "BSE-CD.BO", "BSE Durables" }, { "BSE-TECK.BO", "BSE Teck" }, { "BSE-PSU.BO", "BSE PSU" } } },
  { name = "Stocks", syms = {
    { "RELIANCE.NS", "Reliance" }, { "TCS.NS", "TCS" }, { "HDFCBANK.NS", "HDFC Bank" },
    { "INFY.NS", "Infosys" }, { "ICICIBANK.NS", "ICICI Bank" } } },
}

local COLS, ROWS = 32, 24
local KEEP = 240
local MIN_GAP = 60     -- seconds between two fetches of the same symbol

local gi, si = 1, 1    -- current group, selected row in it
local view = "list"    -- "list" or "chart"
local data = {}        -- data[symbol] = { sym, name, t = {unix}, c = {close}, prev }
local fetched = {}     -- fetched[symbol] = unix seconds of the last good fetch
local errs = {}        -- errs[symbol] = short text for a symbol the server had no data for (this session)
local ago = ""         -- "updated N min ago", refreshed by update_ago (render stays a pure function of state)
local msg = ""         -- error or progress text
local busy = false
local queue = {}       -- symbols still to fetch, one request at a time

local cfg_src = DEFAULT_SOURCE
local groups = {}      -- active groups: { name, syms = {symbol}, label = {symbol -> text} }
local has_mine = false

-- Config is read outside render (render must not touch the stash).
local function reload_config()
  cfg_src = SOURCE
  if cfg_src == "" then
    local s = ship.stash("src")
    cfg_src = (type(s) == "string" and s ~= "") and s or DEFAULT_SOURCE
  end
  groups = {}
  for _, g in ipairs(GROUPS) do
    local e = { name = g.name, syms = {}, label = {} }
    for _, p in ipairs(g.syms) do
      e.syms[#e.syms + 1] = p[1]
      e.label[p[1]] = p[2]
    end
    groups[#groups + 1] = e
  end
  local list = SYMBOLS
  if list == "" then
    local s = ship.stash("symbols")
    list = (type(s) == "string") and s or ""
  end
  local mine = { name = "My list", syms = {}, label = {} }
  for sym in list:gmatch("[^,%s]+") do mine.syms[#mine.syms + 1] = sym end
  has_mine = #mine.syms > 0
  if has_mine then groups[#groups + 1] = mine end
  if gi > #groups then gi = 1 end
  if si > #groups[gi].syms then si = 1 end
end

local function source() return cfg_src end

local function trunc(s, n)
  if #s <= n then return s end
  return s:sub(1, n - 1) .. "~"
end

local function label_of(g, sym)
  local d = data[sym]
  return g.label[sym] or (d and d.name and trunc(d.name, 14)) or trunc((sym:gsub("%.%a+$", "")), 14)
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
  if depth > 10 then error("too deep") end
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
      if v == nil then v = false end   -- JSON null: keep the slot so the array has no holes
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

-- JSON text -> { sym, name, t = {}, c = {}, prev } or nil, reason. Accepts Yahoo's chart shape and the simple points shape.
local function read_points(text, want)
  local ok, doc = pcall(function() return (parse_value(text, 1, 0)) end)
  if not ok or type(doc) ~= "table" then return nil, "unexpected data" end
  local t, c, name, prev = {}, {}, nil, nil
  local sym = want
  if type(doc.chart) == "table" then
    local res = type(doc.chart.result) == "table" and doc.chart.result[1] or nil
    if type(res) ~= "table" then return nil, "no data for " .. want end
    local meta = type(res.meta) == "table" and res.meta or {}
    name = (type(meta.longName) == "string" and meta.longName ~= "" and meta.longName)
      or (type(meta.shortName) == "string" and meta.shortName ~= "" and meta.shortName) or nil
    prev = tonumber(meta.chartPreviousClose) or tonumber(meta.previousClose)
    local q = type(res.indicators) == "table" and type(res.indicators.quote) == "table" and res.indicators.quote[1] or nil
    local closes = type(q) == "table" and q.close or nil
    local ts = type(res.timestamp) == "table" and res.timestamp or {}
    if type(closes) ~= "table" then return nil, "no data for " .. want end
    for i = 1, #closes do
      local close = tonumber(closes[i])
      if close then
        t[#t + 1] = tonumber(ts[i]) or 0
        c[#c + 1] = close
      end
    end
  elseif type(doc.points) == "table" then
    for _, p in ipairs(doc.points) do
      local close = type(p) == "table" and tonumber(p.close) or nil
      if close then
        t[#t + 1] = tonumber(p.t) or 0
        c[#c + 1] = close
      end
    end
    if type(doc.symbol) == "string" and doc.symbol ~= "" then sym = doc.symbol end
  else
    return nil, "unexpected data"
  end
  if #c < 2 then return nil, "no data for " .. want end
  while #c > KEEP do table.remove(t, 1); table.remove(c, 1) end
  return { sym = sym, name = name, t = t, c = c, prev = prev or c[1] }
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

local function update_ago()
  local g = groups[gi]
  local f = g and fetched[g.syms[si]]
  if view == "list" then
    f = nil
    for _, sym in ipairs(g and g.syms or {}) do
      if fetched[sym] and (not f or fetched[sym] < f) then f = fetched[sym] end
    end
  end
  if not f then ago = ""; return end
  local m = (ship.now() - f) // 60
  if m < 1 then ago = "updated just now"
  elseif m == 1 then ago = "updated 1 min ago"
  else ago = "updated " .. m .. " min ago" end
end

local function persist()
  ship.save({ g = groups[gi] and groups[gi].name or "", s = si, v = view, fetched = fetched,
              msg = (msg:sub(1, 7) ~= "Loading") and msg or "" })
end

-- Cache: one stash key per group ("c1".."c5"); each symbol is a header line "@symbol|name|prev" then "t close" lines.
local function pack(g)
  local parts = {}
  for _, sym in ipairs(g.syms) do
    local d = data[sym]
    if d then
      parts[#parts + 1] = "@" .. sym .. "|" .. (d.name or ""):gsub("[|\n]", " ") .. "|" .. d.prev
      for i = 1, #d.c do parts[#parts + 1] = d.t[i] .. " " .. d.c[i] end
    end
  end
  return table.concat(parts, "\n")
end

local function load_cache(i)
  local g = groups[i]
  local raw = g and ship.stash("c" .. i)
  if type(raw) ~= "string" then return end
  local d
  local function done()
    if d and #d.c >= 2 then data[d.sym] = d end
  end
  for line in raw:gmatch("[^\n]+") do
    local sym, name, prev = line:match("^@([^|]+)|([^|]*)|(%S+)$")
    if sym then
      done()
      d = { sym = sym, name = name ~= "" and name or nil, t = {}, c = {}, prev = tonumber(prev) }
    elseif d then
      local t, c = line:match("^(%S+) (%S+)$")
      if tonumber(t) and tonumber(c) then
        d.t[#d.t + 1] = tonumber(t)
        d.c[#d.c + 1] = tonumber(c)
      end
    end
  end
  done()
end

local function save_cache()
  ship.stash("c" .. gi, pack(groups[gi]))
end

local function step()
  local sym = table.remove(queue, 1)
  if not sym then busy = false; return end
  -- symbols keep letters, digits . - _ and ^ (index symbols such as ^NSEI); ^ goes into the URL as %5E
  local clean = sym:gsub("[^%w%.%-_%^]", ""):gsub("%^", "%%5E")
  local url = source():gsub("{symbol}", (clean:gsub("%%", "%%%%")))
  local status, body, err = ship.fetch(url)
  local stop
  if not status then
    msg = "offline: " .. tostring(err)
    stop = true
  elseif status == 429 then
    msg = "rate limited, try later"
    stop = true
  elseif status ~= 200 and status ~= 404 then
    msg = "server answered " .. status
    stop = true
  else
    local d, why = read_points(type(body) == "string" and body or "", sym)
    if not d and status == 404 then why = "no data for " .. sym end
    if d then
      d.sym = sym
      data[sym] = d
      fetched[sym] = ship.now()
      errs[sym] = nil
    else
      errs[sym] = (why or "unexpected data"):sub(1, 40)
    end
  end
  if stop then
    queue = {}
    busy = false
    persist()
    return
  end
  if #queue > 0 then
    msg = "Loading, " .. #queue .. " left"
    ship.later(step)
    return
  end
  busy = false
  msg = ""
  local cur = groups[gi].syms[si]
  if view == "chart" and errs[cur] then msg = errs[cur] end
  save_cache()
  persist()
  update_ago()
  ship.every(60000)
end

-- Fetch the given symbols that are older than MIN_GAP seconds, one request at a time.
local function start_fetch(list)
  if busy then return end
  local now, q = ship.now(), {}
  for _, sym in ipairs(list) do
    if not fetched[sym] or now - fetched[sym] >= MIN_GAP then q[#q + 1] = sym end
  end
  if #q == 0 then return end
  queue = q
  busy = true
  msg = "Loading..."
  ship.later(step)
end

local function fetch_group() start_fetch(groups[gi].syms) end
local function fetch_current() start_fetch({ groups[gi].syms[si] }) end

local function group_has_data(g)
  for _, sym in ipairs(g.syms) do if data[sym] then return true end end
  return false
end

local function enter_group(n)
  gi = (gi - 1 + n) % #groups + 1
  si = 1
  view = "list"
  msg = ""
  load_cache(gi)
  update_ago()
  persist()
  if not group_has_data(groups[gi]) then fetch_group() end
end

function ship.launch()
  reload_config()
  gi = has_mine and #groups or 1
  local s = ship.restore()
  if s then
    msg = type(s.msg) == "string" and s.msg or ""
    for i, g in ipairs(groups) do if g.name == s.g then gi = i end end
    si = (type(s.s) == "number" and s.s >= 1 and s.s <= #groups[gi].syms) and s.s or 1
    view = (s.v == "chart") and "chart" or "list"
    if type(s.fetched) == "table" then
      for k, v in pairs(s.fetched) do if type(v) == "number" then fetched[k] = v end end
    end
  end
  load_cache(gi)
  update_ago()
  if next(fetched) then ship.every(60000) end   -- the "updated N min ago" line ticks only once there is data
end

function ship.press(key)
  local g = groups[gi]
  local n = #g.syms
  if view == "list" then
    if key == "up" or key == "down" then
      si = (si - 1 + (key == "down" and 1 or -1)) % n + 1
      msg = ""
    elseif key == "left" or key == "right" then
      enter_group(key == "right" and 1 or -1)
      return
    elseif key == "ok" then
      reload_config()
      g = groups[gi]
      if not group_has_data(g) then
        fetch_group()
      else
        view = "chart"
        msg = errs[g.syms[si]] or ""
        if not data[g.syms[si]] then fetch_current() end
      end
    end
  else
    if key == "ok" then
      reload_config()
      fetch_current()
    elseif key == "left" or key == "right" then
      si = (si - 1 + (key == "right" and 1 or -1)) % n + 1
      msg = errs[g.syms[si]] or ""
      if not data[g.syms[si]] then fetch_current() end
    elseif key == "up" or key == "down" then
      view = "list"
      msg = ""
    end
  end
  update_ago()
  persist()
end

-- Once a minute while the ship is open and the visible group already has data: refresh what is on screen.
function ship.pulse()
  update_ago()
  if busy then return end
  local g = groups[gi]
  if not group_has_data(g) then return end
  if view == "list" then fetch_group() else fetch_current() end
end

local function short_price(v)
  if v >= 10000 then return string.format("%.0f", v) end
  if v >= 1000 then return string.format("%.1f", v) end
  return string.format("%.2f", v)
end

local function change(d)
  if not d.prev or d.prev == 0 then return "" end
  return string.format("%+.2f%%", (d.c[#d.c] - d.prev) / d.prev * 100)
end

function ship.render(ui)
  local g = groups[gi]
  local sym = g.syms[si]
  local d = data[sym]
  ui.align("center")
  if view == "list" then
    ui.heading(g.name)
    ui.note("Group " .. gi .. " of " .. #groups)
    ui.space(8)
    ui.align("left")
    for i, s in ipairs(g.syms) do
      local e = data[s]
      local value = ""
      if e then value = short_price(e.c[#e.c]) .. " " .. change(e)
      elseif errs[s] then value = "no data" end
      ui.item(label_of(g, s), { selected = (i == si), value = value })
    end
    ui.align("center")
    if msg ~= "" then ui.status(msg)
    elseif ago ~= "" then ui.status(ago)
    elseif not group_has_data(g) then ui.status("Press OK to load")
    else ui.status("delayed ~15 min") end
    ui.hints{ "back", "chart", "< group", "group >" }
    return
  end
  ui.heading(trunc(d and d.name or label_of(g, sym), 20))
  if d then
    local cells, hi, lo = chart_cells(d)
    ui.note(sym .. "   last " .. hhmm(d.t[#d.t]) .. "   close " .. money(d.c[#d.c]) .. " " .. change(d))
    ui.note("High " .. money(hi) .. "   Low " .. money(lo))
    ui.note("# close   o MA10   H MA20")
    ui.space(4)
    ui.grid{ cols = COLS, rows = ROWS, cells = cells }
    if msg ~= "" then ui.status(msg)
    else ui.status(ago ~= "" and ago or "delayed ~15 min") end
  else
    ui.note(sym)
    ui.space(20)
    ui.para(msg ~= "" and msg or "Press OK to fetch")
    ui.status("delayed ~15 min")
  end
  ui.hints{ "back", "fetch", "< prev", "next >" }
end

function ship.dock()
  persist()
end
