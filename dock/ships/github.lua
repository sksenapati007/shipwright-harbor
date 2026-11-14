-- @ship   GitHub
-- @icon   star
-- @api    1
-- @version 1.0.0
-- @accounts github
-- Your open issues, pull requests that wait for your review, and notifications. Sign in once under Settings, Connections
-- (or push a token from Harbor); this ship never sees the token, the OS adds it to requests for api.github.com only.
-- Keys: Left and Right switch list, Up and Down move, OK refreshes (or opens Connections when you are not signed in).
-- Each row is two lines: the title, then "repo . #number . age".

local KEEP = 20          -- rows kept per list
local SHOW = 8           -- rows drawn at once (two entries each)
local TITLE = 64         -- title characters kept (the row is cut by the screen anyway)

local TABS = {
  { name = "Issues", rows = "items",
    url = "https://api.github.com/search/issues?q=is%3Aopen+is%3Aissue+assignee%3A%40me&sort=updated&per_page=20",
    pick = { "title", "number", "updated_at", "repository_url" },
    empty = "No open issues assigned to you" },
  { name = "Reviews", rows = "items",
    url = "https://api.github.com/search/issues?q=is%3Aopen+is%3Apr+review-requested%3A%40me&sort=updated&per_page=20",
    pick = { "title", "number", "updated_at", "repository_url" },
    empty = "No pull requests wait for your review" },
  { name = "Inbox", rows = ".",
    url = "https://api.github.com/notifications?per_page=20",
    pick = { "reason", "updated_at", "subject.title", "repository.full_name" },
    empty = "No unread notifications" },
}

local tab = 1
local sel = { 1, 1, 1 }
local lists = {}       -- lists[i] = { { t = title, r = repo, n = number-or-reason, u = unix, age = "3h" } }
local stamp = {}       -- stamp[i] = unix seconds of the last good fetch
local msg = ""
local busy = false
local linked = false

local function days_from_civil(y, m, d)
  if m <= 2 then y = y - 1 end
  local era = (y >= 0 and y or y - 399) // 400
  local yoe = y - era * 400
  local doy = (153 * (m + (m > 2 and -3 or 9)) + 2) // 5 + d - 1
  local doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
  return era * 146097 + doe - 719468
end

-- "2026-11-13T10:20:30Z" -> unix seconds, or nil
local function parse_time(s)
  if type(s) ~= "string" then return nil end
  local y, mo, d, h, mi, se = s:match("^(%d%d%d%d)-(%d%d)-(%d%d)T(%d%d):(%d%d):(%d%d)")
  if not y then return nil end
  return days_from_civil(tonumber(y), tonumber(mo), tonumber(d)) * 86400 + tonumber(h) * 3600 + tonumber(mi) * 60 + tonumber(se)
end

local function age_text(t)
  if not t then return "" end
  local s = ship.now() - t
  if s < 0 then s = 0 end
  if s < 3600 then return math.max(1, s // 60) .. "m" end
  if s < 86400 then return (s // 3600) .. "h" end
  if s < 86400 * 60 then return (s // 86400) .. "d" end
  return (s // (86400 * 30)) .. "mo"
end

local function update_ages()
  for _, list in pairs(lists) do
    for _, r in ipairs(list) do r.age = age_text(r.u) end
  end
end

local function persist()
  local keep = {}
  for i = 1, #TABS do
    local out = {}
    for j, r in ipairs(lists[i] or {}) do
      if j > KEEP then break end
      out[j] = { t = r.t, r = r.r, n = r.n, u = r.u }
    end
    keep[i] = out
  end
  ship.save({ tab = tab, sel = sel, lists = keep, stamp = stamp })
end

local function clamp_sel()
  local n = #(lists[tab] or {})
  if sel[tab] < 1 then sel[tab] = 1 end
  if sel[tab] > n then sel[tab] = math.max(1, n) end
end

-- One API row -> list row. Tolerates missing or odd fields (an API change must not stop the ship).
local function make_row(i, r)
  if type(r) ~= "table" then return nil end
  local title, repo, num
  if i == 3 then
    local subj = type(r.subject) == "table" and r.subject or {}
    local rp = type(r.repository) == "table" and r.repository or {}
    title, repo, num = subj.title, rp.full_name, r.reason
  else
    title = r.title
    repo = type(r.repository_url) == "string" and r.repository_url:match("/repos/(.+)$") or nil
    num = r.number and ("#" .. tostring(r.number)) or nil
  end
  title = type(title) == "string" and title or "(no title)"
  if #title > TITLE then title = title:sub(1, TITLE - 1) .. "..." end
  local u = parse_time(r.updated_at)
  return { t = title, r = type(repo) == "string" and repo or "", n = type(num) == "string" and num or "", u = u,
           age = age_text(u) }
end

local function do_fetch(i)
  local t = TABS[i]
  local list = {}
  local status, count, err = ship.fetch(t.url, {
    account = "github", rows = t.rows, pick = t.pick,
    each = function(r)
      local row = make_row(i, r)
      if row then list[#list + 1] = row end
      return #list < KEEP
    end,
  })
  busy = false
  if err == "not linked" then
    linked = false
    msg = ""
  elseif err then
    msg = err == "offline" and "Offline: check Wi-Fi" or ("Cannot load: " .. err)
  elseif status == 401 then
    msg = "GitHub rejected the token: sign in again"
  elseif status == 403 or status == 429 then
    msg = "GitHub rate limit, try again later"
  elseif status ~= 200 then
    msg = "GitHub answered " .. tostring(status)
  else
    lists[i] = list
    stamp[i] = ship.now()
    msg = ""
    clamp_sel()
  end
  persist()
end

local function start_fetch()
  if busy then return end
  busy = true
  msg = "Loading..."
  local i = tab
  ship.later(function() do_fetch(i) end)
end

function ship.launch()
  linked = ship.account("github")
  local s = ship.restore()
  if type(s) == "table" then
    if type(s.tab) == "number" and TABS[s.tab] then tab = s.tab end
    if type(s.sel) == "table" then
      for i = 1, #TABS do sel[i] = type(s.sel[i]) == "number" and s.sel[i] or 1 end
    end
    if type(s.stamp) == "table" then
      for i = 1, #TABS do stamp[i] = type(s.stamp[i]) == "number" and s.stamp[i] or nil end
    end
    if type(s.lists) == "table" then
      for i = 1, #TABS do
        local out = {}
        for _, r in ipairs(type(s.lists[i]) == "table" and s.lists[i] or {}) do
          if type(r) == "table" and type(r.t) == "string" then
            out[#out + 1] = { t = r.t, r = tostring(r.r or ""), n = tostring(r.n or ""), u = tonumber(r.u) }
          end
        end
        lists[i] = out
      end
    end
  end
  update_ages()
  clamp_sel()
  if next(stamp) then ship.every(60000) end
end

function ship.press(key)
  linked = ship.account("github")
  if not linked then
    if key == "ok" then ship.link("github") end
    return
  end
  if key == "ok" then
    start_fetch()
    ship.every(60000)
  elseif key == "left" or key == "right" then
    tab = (tab - 1 + (key == "right" and 1 or -1)) % #TABS + 1
    msg = ""
    clamp_sel()
    if not stamp[tab] then start_fetch() end
    persist()
  elseif key == "up" or key == "down" then
    sel[tab] = sel[tab] + (key == "down" and 1 or -1)
    clamp_sel()
  end
end

function ship.pulse()
  update_ages()
end

local function header(ui)
  local line = {}
  for i, t in ipairs(TABS) do line[#line + 1] = (i == tab) and ("[" .. t.name .. "]") or t.name end
  ui.note(table.concat(line, "   "))
  ui.divider()
end

function ship.render(ui)
  ui.align("left")
  header(ui)
  if not linked then
    ui.space(16)
    ui.para("GitHub is not connected.")
    ui.note("Press OK to open Connections and sign in, or push a token from Harbor.")
    ui.hints{ "back", "connect" }
    return
  end
  local list = lists[tab] or {}
  if #list == 0 then
    ui.space(16)
    if msg ~= "" then ui.para(msg)
    elseif stamp[tab] then ui.para(TABS[tab].empty)
    else ui.para("Press OK to load") end
  else
    local first = math.max(1, math.min(sel[tab] - SHOW // 2, #list - SHOW + 1))
    for j = first, math.min(#list, first + SHOW - 1) do
      local r = list[j]
      ui.item(r.t, { selected = (j == sel[tab]) })
      local sub = {}
      if r.r ~= "" then sub[#sub + 1] = r.r end
      if r.n ~= "" then sub[#sub + 1] = r.n end
      if r.age and r.age ~= "" then sub[#sub + 1] = r.age end
      ui.note(table.concat(sub, " \xC2\xB7 "))
    end
    ui.space(4)
    ui.note(sel[tab] .. " of " .. #list)
  end
  if msg ~= "" then ui.status(msg) end
  ui.hints{ "back", "refresh", "< list", "list >" }
end

function ship.dock()
  persist()
end
