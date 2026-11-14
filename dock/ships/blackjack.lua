-- @ship   Blackjack
-- @icon   blackjack
-- @api    1
-- @version 1.0.0
-- One player against the dealer. Left and right set the bet and pick Hit or Stand, OK confirms. The dealer stands on 17.
-- Blackjack pays 3 to 2. Chips and the hand in progress are saved.

local START_CHIPS, STEP = 100, 10
local SUITS = { "S", "H", "D", "C" }
local RANKS = { "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K" }

local chips, bet = START_CHIPS, STEP
local mode = "bet"            -- bet, play, done
local player, dealer, deck = {}, {}, {}
local sel = 1                 -- 1 Hit, 2 Stand
local msg = ""

local function value(hand)
  local total, aces = 0, 0
  for _, c in ipairs(hand) do
    local r = c:sub(1, #c - 1)
    if r == "A" then
      total, aces = total + 11, aces + 1
    elseif r == "K" or r == "Q" or r == "J" then
      total = total + 10
    else
      total = total + (tonumber(r) or 0)
    end
  end
  while total > 21 and aces > 0 do
    total, aces = total - 10, aces - 1
  end
  return total
end

local function persist()
  ship.save({ chips = chips, bet = bet, mode = mode, player = player, dealer = dealer, deck = deck,
              sel = sel, msg = msg })
end

local function shuffle()
  deck = {}
  for _, s in ipairs(SUITS) do
    for _, r in ipairs(RANKS) do deck[#deck + 1] = r .. s end
  end
  for i = #deck, 2, -1 do
    local j = math.random(i)
    deck[i], deck[j] = deck[j], deck[i]
  end
end

local function draw()
  return table.remove(deck)
end

local function settle()
  local p = value(player)
  while value(dealer) < 17 and p <= 21 do dealer[#dealer + 1] = draw() end
  local d = value(dealer)
  local natural = #player == 2 and p == 21
  if p > 21 then
    chips, msg = chips - bet, "Bust. You lose " .. bet .. "."
  elseif natural and not (#dealer == 2 and d == 21) then
    local win = bet * 3 // 2
    chips, msg = chips + win, "Blackjack! You win " .. win .. "."
  elseif d > 21 then
    chips, msg = chips + bet, "Dealer busts. You win " .. bet .. "."
  elseif p > d then
    chips, msg = chips + bet, "You win " .. bet .. "."
  elseif p < d then
    chips, msg = chips - bet, "Dealer wins. You lose " .. bet .. "."
  else
    msg = "Push. Your bet is returned."
  end
  mode = "done"
  persist()
end

local function deal()
  shuffle()
  player = { draw(), draw() }
  dealer = { draw(), draw() }
  sel = 1
  mode = "play"
  if value(player) == 21 then settle() else persist() end   -- a hand in progress survives a power cut
end

function ship.launch()
  local s = ship.restore()
  if s and type(s.deck) == "table" and type(s.player) == "table" and type(s.dealer) == "table" then
    chips, bet, sel, msg = s.chips or START_CHIPS, s.bet or STEP, s.sel or 1, s.msg or ""
    mode, player, dealer, deck = s.mode or "bet", s.player, s.dealer, s.deck
  end
end

function ship.press(key)
  if mode == "bet" then
    if key == "up" or key == "right" then
      bet = math.min(bet + STEP, chips)
    elseif key == "down" or key == "left" then
      bet = math.max(bet - STEP, STEP)
    elseif key == "ok" then
      deal()
    end
  elseif mode == "play" then
    if key == "left" then
      sel = 1
    elseif key == "right" then
      sel = 2
    elseif key == "up" or key == "down" then
      sel = 3 - sel
    elseif key == "ok" then
      if sel == 1 then
        player[#player + 1] = draw()
        if value(player) >= 21 then settle() else persist() end
      else
        settle()
      end
    end
  elseif key == "ok" then
    if chips < STEP then
      chips = START_CHIPS
      msg = "Out of chips. Bankroll reset to " .. START_CHIPS .. "."
    end
    bet = math.max(STEP, math.min(bet, chips))
    mode = "bet"
    persist()
  end
end

function ship.render(ui)
  ui.align("center")
  ui.heading("BLACKJACK")
  ui.status("CHIPS " .. chips .. "   BET " .. bet)
  ui.divider()
  if mode == "bet" then
    ui.space(60)
    ui.para("Set your bet, then deal.")
    if msg ~= "" then ui.note(msg) end
    ui.hints{ "menu", "deal", "less", "more" }
    return
  end
  if mode == "play" then
    ui.hand{ cards = { dealer[1], "??" }, label = "DEALER" }
  else
    ui.hand{ cards = dealer, label = "DEALER " .. value(dealer) }
  end
  ui.space(16)
  ui.hand{ cards = player, label = "YOU " .. value(player) }
  ui.space(16)
  if mode == "play" then
    ui.align("left")
    ui.item("Hit", { selected = sel == 1 })
    ui.item("Stand", { selected = sel == 2 })
    ui.hints{ "menu", "confirm", "hit", "stand" }
  else
    ui.para(msg)
    ui.hints{ "menu", "next hand" }
  end
end

function ship.dock()
  persist()
end
