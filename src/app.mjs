import {
  RANKS, SUITS, SEATS, actionCards, cardKey, describe, exposedCards, faceLabel, identify, organize,
  outsideCounts, rankLabel, sortHand, straightFlushes, suitMark, weakest, wildcardRoles
} from './rules.mjs';
import { API, connectRoom, readLocal, roomRequest, validCode, writeLocal } from './room.mjs';

const app = document.querySelector('#app');
const dialog = document.querySelector('#history');
const notice = document.querySelector('#notice');
const connection = document.querySelector('#connection');
const escape = value => String(value ?? '').replace(/[&<>"']/g, token => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[token]);
const isSeat = seat => SEATS.includes(seat);
const roomPath = code => '#/room/' + code;
const dateLabel = value => new Date(value).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
const rankOrder = 'RB' + [...RANKS].reverse().join('');
const declaredShape = action => action.includes(':') ? action.split(':')[0] : action;

let recent = readLocal('rooms', []);
let archive = readLocal('history', []);
let code = null;
let token = null;
let room = null;
let match = null;
let view = null;
let seat = null;
let socket = null;
let link = '';
let screenError = '';
let busy = false;
let mode = '1h-3b';
let displayName = readLocal('name', '玩家');
let joinCode = '';
let routeId = 0;
let seenAction = '';
let pending = null;
let pendingTimer;
let noticeTimer;
let historyTab = 'current';
let historyKey = '';
let handKey = '';
let layout = freshLayout();
let selected = new Set();
let declaration = '';
let hintOpen = false;
let hintChoices = [];
let counterDetails = false;
let selectionMemo;

function freshLayout() {
  return { cards: [], groups: [], nextId: 1 };
}

function toast(message) {
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 3600);
}

function saveLayout() {
  if (handKey) writeLocal('layout:' + code, { key: handKey, ...layout });
}

function syncHand(previous, spentIds = []) {
  const key = [code, room.match_number, room.hand_number ?? match?.hand_number].join(':');
  if (handKey !== key) {
    handKey = key;
    const saved = readLocal('layout:' + code);
    layout = saved?.key === key ? saved : freshLayout();
    selected.clear();
    hintOpen = false;
  }
  const faces = view.hands?.[seat] ?? [];
  const wanted = new Map();
  for (const face of faces) wanted.set(face, (wanted.get(face) ?? 0) + 1);

  // When reconnecting, spend loose copies before removing a copy from a locked group.
  const locked = new Set(layout.groups.flatMap(group => group.ids));
  const spent = new Set(spentIds);
  const ordered = [...layout.cards].sort((a, b) => Number(spent.has(a.id)) - Number(spent.has(b.id))
    || Number(locked.has(b.id)) - Number(locked.has(a.id)));
  const kept = new Set();
  for (const card of ordered) {
    const count = wanted.get(card.face) ?? 0;
    if (!count) continue;
    wanted.set(card.face, count - 1);
    kept.add(card.id);
  }
  const remaining = layout.cards.filter(card => kept.has(card.id));
  for (const [face, count] of wanted) {
    for (let i = 0; i < count; i++) remaining.push({ face, id: layout.nextId++ });
  }
  layout.cards = remaining;
  layout.groups = layout.groups.filter(group => group.ids.every(id => kept.has(id)));
  const ids = new Set(remaining.map(card => card.id));
  selected = new Set([...selected].filter(id => ids.has(id)));
  if (previous?.level_rank !== view.level_rank || cardKey(previous?.hands?.[seat] ?? []) !== cardKey(faces)) {
    hintOpen = false;
  }
  saveLayout();
}

function rememberRoom() {
  recent = [{ code, seat, mode: room?.mode ?? mode, time: Date.now() }, ...recent.filter(item => item.code !== code)].slice(0, 16);
  writeLocal('rooms', recent);
}

function rememberHand() {
  let updated = false;
  archive = archive.map(entry => {
    if (entry.code !== code) return entry;
    const board = (match?.boards ?? []).find(item => item.hand_number === entry.hand
      && item.match_number === entry.matchNumber);
    if (!board?.persisted || entry.board?.persisted) return entry;
    updated = true;
    return { ...entry, board };
  });
  if (view.phase !== 'terminal' || !view.result || !handKey) {
    if (updated) writeLocal('history', archive);
    return;
  }
  const hand = room.hand_number ?? match?.hand_number;
  const old = archive.find(item => item.key === handKey);
  const board = (match?.boards ?? []).find(item => item.hand_number === hand) ?? old?.board;
  const entry = {
    key: handKey, code, seat, hand, matchNumber: room.match_number, level: view.level_rank,
    result: view.result,
    events: view.events, transfers: view.tribute?.transfers, revealed: view.revealed_hands, board, names: Object.fromEntries(
      SEATS.map(id => [id, nameFor(id)])
    ), time: old?.time ?? Date.now()
  };
  archive = [entry, ...archive.filter(item => item.key !== handKey)];
  writeLocal('history', archive);
}

function clearPending() {
  clearTimeout(pendingTimer);
  pending = null;
}

function route() {
  routeId++;
  socket?.close();
  socket = null;
  clearPending();
  code = location.hash.match(/^#\/room\/([A-Z0-9]{6})$/i)?.[1]?.toUpperCase() ?? null;
  token = code ? readLocal('token:' + code) : null;
  room = match = view = seat = null;
  screenError = '';
  busy = false;
  link = code ? 'connecting' : '';
  handKey = seenAction = declaration = '';
  selected.clear();
  hintOpen = false;
  if (dialog.open) dialog.close();
  if (!code) render();
  else if (token) subscribe();
  else lookupRoom();
}

async function lookupRoom() {
  const active = routeId;
  render();
  try {
    const response = await roomRequest('/' + code);
    if (routeId !== active) return;
    room = response.room;
    link = '';
  } catch (error) {
    if (routeId !== active) return;
    link = 'gone';
    screenError = error.message;
  }
  render();
}

function subscribe() {
  const active = routeId;
  socket = connectRoom(code, token, {
    status(status, message) {
      if (active !== routeId) return;
      link = status;
      if (status !== 'open') clearPending();
      if (status === 'gone') {
        screenError = message.code === 'page_outdated' ? '原站房间协议已更新。' : message.message;
        if (message.code !== 'page_outdated') {
          writeLocal('token:' + code, null);
          recent = recent.filter(item => item.code !== code);
          writeLocal('rooms', recent);
        }
      }
      render();
    },
    receive(message) {
      if (active !== routeId) return;
      if (message.type === 'error') {
        clearPending();
        toast(message.message ?? '操作失败');
      } else if (message.type === 'state' || message.type === 'room') {
        const previous = view;
        room = message.room;
        if (message.type === 'state' && message.view?.failed) screenError = '原站报告牌桌运行失败。';
        seat = message.your_seat;
        if (message.type === 'state') {
          view = message.view;
          match = message.match;
          const signature = JSON.stringify([room.match_number, room.hand_number, view.phase, view.history, view.your_turn]);
          const changed = signature !== seenAction;
          const last = view.events?.[previous?.events?.length ?? 0];
          const spent = changed && pending?.type === 'play' && last?.seat === seat && last.action === pending.action
            ? pending.ids : [];
          if (changed) {
            clearPending();
            declaration = '';
            if ((previous?.your_turn && !view.your_turn) || view.phase !== previous?.phase) selected.clear();
          }
          seenAction = signature;
          syncHand(previous, spent);
          rememberHand();
        }
        if (room && seat && recent[0]?.code !== code) rememberRoom();
      }
      render();
      if (dialog.open) renderHistory();
    }
  });
}

async function enterRoom(kind) {
  if (busy) return;
  const target = (code ?? joinCode).trim().toUpperCase();
  if (kind === 'join' && !validCode(target)) {
    toast('请输入 6 位房间号');
    return;
  }
  busy = true;
  screenError = '';
  const active = routeId;
  const name = displayName.trim() || (kind === 'join' ? '搭档' : '玩家');
  writeLocal('name', name);
  render();
  try {
    const data = await roomRequest(kind === 'join' ? '/' + target + '/join' : '', {
      ...(kind === 'create' ? { mode } : {}), display_name: name
    });
    const id = data.room_id ?? target;
    writeLocal('token:' + id, data.your_token);
    if (routeId !== active) return;
    if (location.hash === roomPath(id)) route();
    else location.hash = roomPath(id);
  } catch (error) {
    if (routeId !== active) return;
    busy = false;
    screenError = error.message;
    render();
  }
}

function nameFor(id) {
  const player = room?.seats?.[id];
  if (player?.display_name) return player.display_name;
  return player?.kind === 'bot' ? 'Miai ' + (SEATS.indexOf(id) + 1) : id === seat ? '我' : '搭档';
}

function card(face, options = {}) {
  const joker = face.endsWith('j');
  const red = 'hd'.includes(face[1]) || face === 'Rj';
  const suit = joker ? (red ? '★' : '✦') : suitMark[face[1]];
  const rank = joker ? (red ? '大王' : '小王') : rankLabel(face[0]);
  const wild = face === (options.level ?? view?.level_rank) + 'h';
  const cls = 'card' + (red ? ' red' : '') + (joker ? ' joker' : '') + (wild ? ' wild' : '')
    + (options.active ? ' picked' : '') + (options.known ? ' known' : '');
  const as = options.as;
  const label = escape(faceLabel(face) + (wild ? '，百搭' : '') + (options.known ? '，明牌' : '')
    + (as ? '，作 ' + as : ''));
  const style = options.style ? ' style="' + options.style + '"' : '';
  const content = '<span class="corner"><b>' + escape(rank) + '</b><span>' + escape(suit) + '</span></span>'
    + '<span class="pip" aria-hidden="true">' + escape(suit) + '</span>'
    + (wild ? '<span class="wild-label" aria-hidden="true">' + escape(as || '百搭') + '</span>' : '');
  if (options.id == null) return '<span class="' + cls + '"' + style + ' role="img" aria-label="' + label + '">' + content + '</span>';
  return '<button type="button" class="' + cls + '"' + style + ' data-action="card" data-value="' + options.id
    + '" aria-label="' + label + '" aria-pressed="' + Boolean(options.active) + '"' + (options.disabled ? ' disabled' : '') + '>' + content + '</button>';
}

function cardLine(faces, cls = '', known = false, level, action) {
  const roles = action ? wildcardRoles(action, level) : [];
  return '<div class="card-line ' + cls + '">'
    + faces.map((face, i) => card(face, { known, level, as: roles[i] })).join('') + '</div>';
}

function lobbyArt() {
  return '<div class="lobby-art" aria-hidden="true"><div class="art-orbit"></div><span class="art-suit top">♣</span>'
    + '<span class="art-suit bottom">♦</span><div class="art-cards">'
    + ['As', 'Kh', 'Rj'].map(face => card(face)).join('') + '</div>'
    + '<div class="art-chips"><i></i><i></i><i></i></div></div>';
}

function lobby() {
  const list = recent.map(item => '<a class="recent-room" href="' + roomPath(item.code) + '"><strong>'
    + escape(item.code) + '</strong><span>' + (item.mode === '2h-2b' ? '双人组队' : '单人对战')
    + '</span><span>' + dateLabel(item.time) + '</span><span class="recent-open">继续对局</span></a>').join('');
  return '<section class="lobby-hero"><div class="hero-copy"><h1>掼蛋<span>牌室</span></h1><p>和 Miai 打一局，或邀好友并肩上桌。</p></div>' + lobbyArt() + '</section>'
    + '<section class="lobby-body"><div class="lobby-panel"><h2>开始对局</h2>'
    + '<div class="mode-grid" aria-label="对局模式">'
    + modeButton('1h-3b', '♠', '单人对战', '1 位玩家 · 3 位 Miai')
    + modeButton('2h-2b', '♣', '双人组队', '2 位玩家 · 2 位 Miai') + '</div>'
    + '<form data-form="create" class="lobby-form"><label>玩家昵称<input name="display-name" maxlength="32" autocomplete="nickname" value="'
    + escape(displayName) + '"></label><button type="submit" class="primary"' + (busy ? ' disabled' : '') + '>'
    + (busy ? '请稍候' : mode === '2h-2b' ? '创建房间' : '开始对局') + '</button></form></div>'
    + '<div class="lobby-panel join-panel"><div><h2>加入房间</h2><p>输入好友分享的房间号，一起对战 Miai。</p></div>'
    + '<form data-form="join" class="join-form"><label>房间号<input name="room-code" maxlength="6" placeholder="例如 A1B2C3" required autocapitalize="characters" autocomplete="off" value="'
    + escape(joinCode) + '"></label><button type="submit"' + (busy ? ' disabled' : '') + '>加入房间</button></form></div>'
    + errorMarkup() + '</section>'
    + (list ? '<section class="recent"><h2>最近房间</h2>' + list + '</section>' : '')
    + '<footer>对局由 <a href="' + API + '/" target="_blank" rel="noopener noreferrer">Miai 掼蛋</a> 提供</footer>';
}

function modeButton(value, symbol, title, description) {
  return '<button type="button" class="mode" data-action="mode" data-value="' + value + '" aria-pressed="' + (mode === value) + '">'
    + '<span class="mode-icon" aria-hidden="true">' + symbol + '</span><span><b>' + title + '</b><small>' + description
    + '</small></span><span class="radio" aria-hidden="true"></span></button>';
}

function errorMarkup() {
  return screenError ? '<p class="error" role="alert">' + escape(screenError) + '</p>' : '';
}

function waiting() {
  let content = '';
  let heading = '正在连接房间';
  if (link === 'gone' || view?.failed) {
    heading = '房间无法打开';
    content = errorMarkup() + '<a class="button" href="#">返回大厅</a>';
  } else if (!token && room) {
    const vacant = room.invited_seat && !room.seats?.[room.invited_seat]?.claimed;
    heading = vacant ? '加入好友的牌桌' : '房间已无空位';
    content = vacant ? '<p>' + escape(room.seats?.[room.creator_seat]?.display_name || '好友')
      + ' 邀请你组队对战 Miai。</p><form data-form="join" class="lobby-form"><label>玩家昵称<input name="display-name" maxlength="32" value="'
      + escape(displayName) + '"></label><button class="primary"' + (busy ? ' disabled' : '') + '>加入房间</button></form>' + errorMarkup()
      : '<a class="button" href="#">返回大厅</a>';
  } else if (room && token) {
    heading = '等待搭档入座';
    content = '<p>把房间号或邀请链接发给好友，好友入座后自动开局。</p>'
      + '<div class="invite-actions"><button class="primary" data-action="invite">复制邀请链接</button>'
      + '<button data-action="copy-code">复制房间号</button></div>';
  } else {
    content = '<p>正在同步牌桌和座位。</p><a class="button" href="#">返回大厅</a>';
  }
  return '<section class="waiting"><span class="eyebrow">房间 ' + escape(code) + '</span><h1>' + heading + '</h1>' + content + '</section>';
}

function score() {
  const team = Number(seat[1]) % 2;
  return '<div class="score"><span>我方级牌 <b>' + rankLabel(match?.levels?.[team])
    + '</b></span><span>对方级牌 <b>' + rankLabel(match?.levels?.[1 - team])
    + '</b></span><span class="current-level">本手打 <b>' + rankLabel(view.level_rank) + '</b></span></div>';
}

function counter() {
  const inHand = view.hands?.[seat] ?? [];
  const values = outsideCounts(inHand, view.events ?? []);
  const content = [...rankOrder].map(rank => {
    const faces = 'BR'.includes(rank) ? [rank + 'j'] : [...SUITS].reverse().map(suit => rank + suit);
    const total = faces.reduce((sum, face) => sum + values[face], 0);
    const detail = faces.length === 1 ? '' : '<div class="counter-suits">' + faces.map(face => '<span'
      + ('hd'.includes(face[1]) ? ' class="red"' : '') + '>' + suitMark[face[1]] + values[face] + '</span>').join('') + '</div>';
    return '<div class="counter-cell' + (total ? '' : ' empty') + (rank === view.level_rank ? ' level' : '')
      + '" title="' + faces.map(face => faceLabel(face) + ' ' + values[face]).join(' / ') + '"><span>' + rankLabel(rank)
      + '</span><strong>' + total + '</strong>' + (counterDetails ? detail : '') + '</div>';
  }).join('');
  return '<section class="counter"><div class="counter-head"><h2>记牌器 <small>外面剩余</small></h2>' + score()
    + '<button class="quiet counter-toggle" data-action="counter" aria-expanded="' + counterDetails + '">'
    + (counterDetails ? '收起花色' : '展开花色') + '</button></div><div class="counter-grid">' + content + '</div></section>';
}

function seatBox(id, position) {
  const player = room.seats?.[id];
  const local = id === seat;
  const count = view.hand_sizes?.[id] ?? 0;
  const publicCards = exposedCards(view, id);
  const showCurrent = !local && view.current_actor === id && view.phase !== 'terminal';
  const order = (view.result?.finish_order ?? view.finished ?? []).indexOf(id);
  const marker = local ? '我' : (Number(id[1]) - Number(seat[1]) + 4) % 4 === 2 ? '搭档' : '对手';
  const representative = player?.kind === 'bot' ? '♠' : Array.from(nameFor(id))[0];
  const back = '<span class="card-back" aria-hidden="true">♠</span>';
  const fan = (count > publicCards.length ? back.repeat(Math.min(4, count - publicCards.length)) : '');
  return '<div class="seat seat-' + position + (showCurrent ? ' active' : '') + '"><div class="seat-info"><span class="avatar">'
    + escape(representative) + '</span><div class="seat-name"><b>' + escape(nameFor(id)) + '</b><small>' + marker
    + (order >= 0 ? ' · ' + ['头游', '二游', '三游', '末游'][order] : '') + '</small></div><strong class="remaining">'
    + count + '<small> 张</small></strong></div>'
    + (!local && (publicCards.length || fan) ? '<div class="opponent-hand">' + cardLine(publicCards, 'known-cards', true) + fan + '</div>' : '')
    + '</div>';
}

function latestPlay() {
  const events = view.events ?? [];
  const current = events.filter(event => event.trick === view.current_trick);
  return [...current].reverse().find(event => event.action !== 'PASS');
}

function playTable() {
  const partner = (Number(seat[1]) + 2) % 4;
  const myIndex = Number(seat[1]);
  const others = [[SEATS[partner], 'top'], [SEATS[(myIndex + 3) % 4], 'left'], [SEATS[(myIndex + 1) % 4], 'right']];
  const last = latestPlay();
  const transfer = view.tribute?.transfers ?? [];
  const phase = view.phase;
  const exchange = phase === 'tribute' || phase === 'return';
  let center;
  if (phase === 'terminal') {
    const won = view.result?.winner_team === myIndex % 2;
    const matchWon = match?.winner_team != null;
    center = '<span class="eyebrow">第 ' + (room.hand_number ?? match?.hand_number ?? '—') + ' 手结算</span><strong class="table-title">'
      + (won ? '我方' : '对方') + (matchWon ? '赢得本局' : '赢得本手') + '</strong><span>'
      + (view.result?.finish_order ?? []).map(id => escape(nameFor(id))).join(' · ') + '</span>';
  } else if (exchange) {
    center = '<span class="eyebrow">换牌阶段</span><strong class="table-title">' + (phase === 'tribute' ? '进贡' : '还贡')
      + '</strong>' + cardLine(transfer.map(item => item.card), 'played');
  } else if (last) {
    const combo = describe(last.action, view.level_rank);
    const skips = [];
    for (const event of [...(view.events ?? [])].reverse()) {
      if (event.trick !== view.current_trick || event.action !== 'PASS') break;
      skips.unshift(escape(nameFor(event.seat)));
    }
    center = '<span class="eyebrow">' + escape(nameFor(last.seat)) + ' · ' + escape(combo.name) + '</span>'
      + cardLine(last.cards ?? combo.cards, 'played', false, view.level_rank, last.action) + (skips.length ? '<small class="table-passes">' + skips.join('、') + ' 不出</small>' : '');
  } else {
    center = '<span class="table-suit" aria-hidden="true">♠</span><strong class="table-title">自由领出</strong>';
  }
  return '<section class="table" aria-label="掼蛋牌桌"><div class="felt"></div>'
    + others.map(([id, position]) => seatBox(id, position)).join('') + '<div class="table-center">' + center + '</div></section>';
}

function currentSelection() {
  return layout.cards.filter(card => selected.has(card.id));
}

function selectionActions() {
  const picked = currentSelection();
  const key = cardKey(picked.map(item => item.face));
  if (!key || !view.your_turn) return [];
  if (view.phase !== 'play') {
    return picked.length === 1 ? (view.legal_actions ?? []).map(item => item.action)
      .filter(action => actionCards(action).join('') === key) : [];
  }
  if (selectionMemo?.combos === view.legal_combos && selectionMemo?.key === key) return selectionMemo.actions;
  const actions = (view.legal_combos ?? []).filter(action => action !== 'PASS' && cardKey(actionCards(action)) === key);
  selectionMemo = { combos: view.legal_combos, key, actions };
  return actions;
}

function chosenAction(actions) {
  if (actions.length === 1) return actions[0];
  return actions.find(action => action === declaration)
    ?? actions.find(action => declaredShape(action) === declaredShape(declaration))
    ?? '';
}

function controls() {
  const ownTurn = link === 'open' && view.your_turn && !pending;
  const phase = view.phase;
  const play = phase === 'play';
  const terminal = phase === 'terminal';
  const actions = selectionActions();
  const canPass = (view.legal_combos ?? []).includes('PASS');
  const canSuggest = (view.legal_combos ?? []).some(action => action !== 'PASS');
  const choice = chosenAction(actions);
  let status = '等待 ' + nameFor(view.current_actor) + ' 操作';
  if (view.your_turn) status = play ? (canPass ? '轮到你接牌' : '轮到你领出') : '请选择一张牌';
  if (terminal) status = '本手已结束';
  if (pending) status = '正在提交操作';
  if (link !== 'open') status = '正在重新连接';
  const myKnown = exposedCards(view, seat);
  const disable = condition => condition ? ' disabled' : '';
  const choices = play && actions.length > 1 ? '<label class="declare">牌型<select name="declaration"><option value="">请选择</option>'
    + actions.map(action => '<option value="' + escape(action) + '"' + (choice === action ? ' selected' : '') + '>'
      + escape(describe(action, view.level_rank).name) + '</option>').join('') + '</select></label>' : '';
  const ready = room.next_hand_ready?.includes(seat);
  return '<div class="table-controls"><div class="local-seat">' + seatBox(seat, 'self')
    + (myKnown.length ? cardLine(myKnown, 'own-known', true) : '') + '<span class="turn-text" aria-live="polite">' + escape(status) + '</span></div>'
    + '<div class="play-actions">' + choices + (terminal
      ? '<button class="primary" data-action="next"' + disable(link !== 'open' || pending || ready) + '>'
        + (ready ? '等待搭档' : match?.winner_team != null ? '开始新局' : '下一手') + '</button>'
      : (play ? '<button data-action="pass"' + disable(!ownTurn || !canPass) + '>不出</button>'
        + '<button data-action="suggest"' + disable(!ownTurn || !canSuggest) + '>自动选牌</button>' : '')
        + '<button class="primary" data-action="play"' + disable(!ownTurn || !choice) + '>'
        + (play ? '出牌' : phase === 'tribute' ? '进贡' : '还贡') + '</button>') + '</div></div>';
}

function stackColumns(hand) {
  const groups = new Map();
  for (const item of hand) {
    const rank = item.face[0];
    if (!groups.has(rank)) groups.set(rank, []);
    groups.get(rank).push(item);
  }
  return [...groups.values()];
}

function handMarkup() {
  const sorted = sortHand(layout.cards, view.level_rank);
  const ownKnown = exposedCards(view, seat);
  const knownIds = new Set();
  for (const face of ownKnown) {
    const item = sorted.find(item => item.face === face && !knownIds.has(item.id));
    if (item) knownIds.add(item.id);
  }
  const grouped = new Set(layout.groups.flatMap(group => group.ids));
  const loose = sorted.filter(item => !grouped.has(item.id));
  const columns = stackColumns(loose);
  const canPick = view.phase !== 'terminal';
  const exchange = ['tribute', 'return'].includes(view.phase);
  const allowed = exchange ? new Set(selectionFaces(view.legal_actions ?? [])) : null;
  const disabledFace = item => !canPick || (exchange && (!view.your_turn || !allowed.has(item.face)));
  const buildCard = (item, style = '') => card(item.face, {
    id: item.id, active: selected.has(item.id), known: knownIds.has(item.id), disabled: disabledFace(item), style
  });
  const groupMarkup = layout.groups.map((group, i) => {
    const items = group.ids.map(id => sorted.find(item => item.id === id)).filter(Boolean);
    const style = '--size:' + items.length;
    const name = describe(group.action, view.level_rank).name;
    return '<div class="locked-group" style="' + style + '"><div class="group-cards">'
      + items.map((item, index) => buildCard(item, '--i:' + index)).join('')
      + '</div><div class="group-label"><button class="group-pick" data-action="group" data-value="' + i + '" title="选择整组">'
      + escape(name) + '</button><button class="group-unlock" data-action="unlock" data-value="' + i + '" aria-label="解除锁定 ' + escape(name)
      + '" title="解除锁定">×</button></div></div>';
  }).join('');
  const columnMarkup = columns.map(items => '<div class="rank-stack" style="--size:' + items.length + '">'
    + items.map((item, index) => buildCard(item, '--i:' + (items.length - index - 1))).join('') + '</div>').join('');
  const hints = hintOpen ? '<div class="hints"><strong>同花顺</strong>'
    + (!hintChoices.length ? '<span>手中暂无同花顺</span>' : hintChoices.map((item, i) => '<button data-action="hint-pick" data-value="' + i
      + '">' + escape(item.name.replace('同花顺 ', '')) + '</button>').join(''))
    + '<button class="quiet hint-close" data-action="hint-close" aria-label="关闭同花顺提示">×</button></div>' : '';
  const legalForLock = view.phase === 'play' && selected.size > 0;
  return '<section class="hand" aria-label="我的手牌"><div class="hand-head"><h2>我的手牌 <small>' + sorted.length
    + ' 张</small></h2><div class="organize-actions"><button data-action="basic">基本整理</button>'
    + '<button data-action="lock"' + (!legalForLock ? ' disabled' : '') + '>锁定组合</button>'
    + '<button data-action="auto"' + (canPick && !exchange ? '' : ' disabled') + '>自动整理</button>'
    + '<button data-action="flush" aria-expanded="' + hintOpen + '">同花顺提示</button></div></div>'
    + hints + '<div class="hand-scroll" tabindex="0" aria-label="手牌，可横向滚动"><div class="hand-layout">' + groupMarkup + columnMarkup
    + (sorted.length ? '' : '<span class="muted">手牌已出完</span>') + '</div></div>'
    + '<div class="hand-foot"><span>' + (selected.size ? '已选 ' + selected.size + ' 张' : '点击手牌选择，点击组合名称可选中整组')
    + '</span>' + (selected.size ? '<button class="quiet" data-action="clear">清空选择</button>' : '') + '</div></section>';
}

function selectionFaces(actions) {
  return actions.flatMap(item => actionCards(item.action));
}

function game() {
  return '<div class="game-head"><div><a class="back-link" href="#">返回大厅</a><h1>房间 <span>' + escape(code)
    + '</span></h1></div><div class="game-tools"><span>第 ' + escape(room.match_number ?? 1) + ' 局 · 第 '
    + escape(room.hand_number ?? match?.hand_number ?? '—') + ' 手</span><button data-action="invite">复制邀请</button></div></div>'
    + counter() + playTable() + controls() + handMarkup();
}

function render() {
  const focused = document.activeElement;
  const focusAction = focused?.dataset?.action;
  const focusValue = focused?.dataset?.value;
  const name = focused?.name;
  const handOffset = app.querySelector('.hand-scroll')?.scrollLeft;
  const gameActive = code && room && view && isSeat(seat) && !view.failed && link !== 'gone';
  const homeLink = document.querySelector('[data-nav="home"]');
  if (code) homeLink.removeAttribute('aria-current');
  else homeLink.setAttribute('aria-current', 'page');
  connection.className = 'connection ' + (link === 'open' ? 'online' : '');
  connection.textContent = link === 'open' ? '牌桌已连接' : link === 'connecting' ? '连接中' : '';
  app.innerHTML = code ? gameActive ? game() : waiting() : lobby();
  const scroll = app.querySelector('.hand-scroll');
  if (scroll && handOffset) scroll.scrollLeft = handOffset;
  if (app.contains(document.activeElement) || dialog.open) return;
  const target = focusAction ? [...app.querySelectorAll('[data-action]')].find(item => item.dataset.action === focusAction
    && item.dataset.value === focusValue) : name ? app.querySelector('[name="' + name + '"]') : null;
  target?.focus({ preventScroll: true });
}

function historyEntry() {
  if (!view || !code) return null;
  return {
    key: handKey, code, hand: room.hand_number ?? match?.hand_number, matchNumber: room.match_number,
    level: view.level_rank, result: view.result, events: view.events,
    transfers: view.tribute?.transfers, revealed: view.revealed_hands,
    names: Object.fromEntries(SEATS.map(id => [id, nameFor(id)]))
  };
}

function replayLink(board) {
  return board?.hand_id && board.persisted
    ? '<a class="button" href="' + API + '/replay/' + encodeURIComponent(board.hand_id)
      + '" target="_blank" rel="noopener noreferrer">原站回放</a>' : '';
}

function historyDetail(item) {
  if (!item) return '<p class="history-empty">当前没有进行中的对局。</p>';
  const showName = id => escape(item.names?.[id] || id);
  const transfers = (item.transfers ?? []).map(event => '<li><span>' + showName(event.from) + ' 给 ' + showName(event.to)
    + '</span><small>' + (event.kind === 'tribute' ? '进贡' : '还贡') + '</small>' + cardLine([event.card], '', false, item.level) + '</li>');
  const plays = (item.events ?? []).map(event => '<li><span>' + showName(event.seat) + '</span>'
    + '<small>' + escape(describe(event.action, item.level).name) + '</small>' + cardLine(event.cards ?? actionCards(event.action), '', false, item.level, event.action) + '</li>');
  const names = (item.result?.finish_order ?? []).map(showName);
  const revealed = item.revealed && '<details class="revealed"><summary>查看结算手牌</summary>'
    + SEATS.map(id => '<div><b>' + showName(id) + '</b>' + cardLine(item.revealed[id] ?? [], '', false, item.level) + '</div>').join('') + '</details>';
  return '<div class="history-subhead"><div><b>' + escape(item.code) + ' · 第 ' + escape(item.matchNumber ?? 1)
    + ' 局第 ' + escape(item.hand ?? '—') + ' 手</b><span>本手打 ' + rankLabel(item.level) + '</span></div>' + replayLink(item.board) + '</div>'
    + (names.length ? '<p class="finish-order">名次　' + names.join(' · ') + '</p>' : '') + (revealed || '')
    + (transfers.length || plays.length ? '<ol class="history-events">' + transfers.concat(plays).join('') + '</ol>'
      : '<p class="history-empty">本手还没有出牌记录。</p>');
}

function historyScore() {
  const rows = (match?.records ?? []).map(record => {
    const board = (match?.boards ?? []).find(item => item.hand_number === record.hand_number);
    const team = Number(seat?.[1]) % 2;
    return '<li><div><b>第 ' + escape(record.hand_number) + ' 手</b><small>本手打 ' + rankLabel(record.level_rank)
      + ' · ' + (record.winner_team === team ? '我方' : '对方') + '升 ' + escape(record.upgrade ?? 0) + ' 级</small></div>'
      + '<span>' + (record.finish_order ?? []).map(id => escape(nameFor(id))).join(' · ') + '</span>' + replayLink(board) + '</li>';
  });
  return rows.length ? '<ul class="history-scores">' + rows.join('') + '</ul>'
    : '<p class="history-empty">本局还没有结算记录。</p>';
}

function historyArchive() {
  const entry = archive.find(item => item.key === historyKey);
  if (entry) return '<button class="quiet archive-back" data-action="history-entry" data-value="">返回历史列表</button>' + historyDetail(entry);
  return archive.length ? '<ul class="history-scores">' + archive.map(item => '<li><button class="archive-row" data-action="history-entry" data-value="'
    + escape(item.key) + '"><span><b>' + escape(item.code) + ' · 第 ' + escape(item.matchNumber ?? 1) + ' 局第 '
    + escape(item.hand) + ' 手</b><small>本手打 ' + rankLabel(item.level) + ' · '
    + (item.result?.winner_team === Number(item.seat?.[1]) % 2 ? '我方胜出' : '对方胜出') + '</small></span><span>'
    + dateLabel(item.time) + '</span></button></li>').join('') + '</ul>'
    : '<p class="history-empty">完成一手对局后，记录会保存在此浏览器。</p>';
}

function renderHistory() {
  const previousScroll = dialog.querySelector('.history-body')?.scrollTop ?? 0;
  const focused = dialog.contains(document.activeElement) ? document.activeElement.dataset : {};
  const tabs = [['current', '本手出牌'], ['score', '本局战绩'], ['archive', '历史对局']];
  dialog.innerHTML = '<header class="history-head"><h2 id="history-title">对局历史</h2>'
    + '<button class="quiet" data-action="history-close" aria-label="关闭对局历史">×</button></header>'
    + '<div class="history-tabs">' + tabs.map(([value, label]) => '<button data-action="history-tab" data-value="' + value
      + '" aria-pressed="' + (historyTab === value) + '">' + label + '</button>').join('') + '</div>'
    + '<div class="history-body">' + (historyTab === 'current' ? historyDetail(historyEntry())
      : historyTab === 'score' ? historyScore() : historyArchive()) + '</div>';
  dialog.querySelector('.history-body').scrollTop = previousScroll;
  if (focused.action) [...dialog.querySelectorAll('[data-action]')]
    .find(item => item.dataset.action === focused.action && item.dataset.value === focused.value)?.focus({ preventScroll: true });
}

function requestAction(action) {
  if (!view?.your_turn || link !== 'open' || pending) return;
  if (!socket.send(action)) {
    toast('连接中断，请稍后重试');
    return;
  }
  pending = { type: 'play', action, ids: [...selected] };
  pendingTimer = setTimeout(() => {
    clearPending();
    toast('服务器暂未确认，请查看牌桌状态');
    render();
  }, 12000);
  render();
}

async function nextHand() {
  if (pending || link !== 'open' || view?.phase !== 'terminal') return;
  const active = routeId;
  pending = { type: 'next' };
  render();
  try {
    await roomRequest('/' + code + '/new_hand', { player_token: token });
  } catch (error) {
    if (active === routeId) toast(error.message);
  } finally {
    if (active === routeId && pending?.type === 'next') {
      clearPending();
      render();
    }
  }
}

function pickCombo(combo) {
  if (!combo) return;
  const pool = [...layout.cards].sort((a, b) => {
    const inGroup = item => layout.groups.some(group => group.ids.includes(item.id));
    return Number(inGroup(a)) - Number(inGroup(b));
  });
  const ids = combo.ids ?? combo.cards.map(face => {
    const index = pool.findIndex(item => item.face === face);
    return index < 0 ? null : pool.splice(index, 1)[0].id;
  });
  if (ids.some(id => id === null)) return;
  selected = new Set(ids);
  declaration = combo.action;
  render();
  const first = app.querySelector('.hand-layout .picked');
  first?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function setLayout(groups) {
  layout.groups = groups;
  selected.clear();
  declaration = '';
  saveLayout();
  render();
}

function lockSelection() {
  const picked = currentSelection();
  const legal = identify(picked, view.level_rank);
  if (!legal.length) {
    toast('所选手牌无法组成合法牌型');
    return;
  }
  const exact = legal.find(combo => declaredShape(combo.action) === declaredShape(declaration));
  const flush = legal.find(combo => combo.bomb === 6);
  const weakestAction = weakest(legal.map(item => item.action), view.level_rank)?.action;
  const combo = exact ?? flush ?? legal.find(item => item.action === weakestAction);
  setLayout([...layout.groups.filter(group => !group.ids.some(id => selected.has(id))),
    { ids: combo.ids, action: combo.action }]);
}

async function copyText(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    toast(label + '已复制');
  } catch {
    window.prompt(label, value);
  }
}

document.addEventListener('input', event => {
  if (event.target.name === 'display-name') displayName = event.target.value;
  if (event.target.name === 'room-code') {
    joinCode = event.target.value.toUpperCase();
    event.target.value = joinCode;
  }
});
document.addEventListener('change', event => {
  if (event.target.name === 'declaration') {
    declaration = event.target.value;
    render();
  }
});
document.addEventListener('submit', event => {
  if (!event.target.dataset.form) return;
  event.preventDefault();
  enterRoom(event.target.dataset.form);
});
document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const { action, value } = button.dataset;
  switch (action) {
    case 'mode':
      mode = value;
      render();
      break;
    case 'invite':
      copyText(new URL(roomPath(code), location.href).href, '邀请链接');
      break;
    case 'copy-code':
      copyText(code, '房间号');
      break;
    case 'counter':
      counterDetails = !counterDetails;
      render();
      break;
    case 'history':
      if (dialog.open) { dialog.close(); break; }
      historyTab = view ? 'current' : 'archive';
      historyKey = '';
      renderHistory();
      dialog.showModal();
      break;
    case 'history-close':
      dialog.close();
      break;
    case 'history-tab':
      historyTab = value;
      historyKey = '';
      renderHistory();
      dialog.querySelector('.history-body').scrollTop = 0;
      break;
    case 'history-entry':
      historyKey = value;
      renderHistory();
      dialog.querySelector('.history-body').scrollTop = 0;
      break;
    case 'card': {
      const id = Number(value);
      if (selected.has(id)) selected.delete(id);
      else {
        if (view.phase !== 'play') selected.clear();
        selected.add(id);
      }
      declaration = '';
      render();
      break;
    }
    case 'clear':
      selected.clear();
      declaration = '';
      render();
      break;
    case 'basic':
      setLayout([]);
      break;
    case 'lock':
      lockSelection();
      break;
    case 'unlock':
      setLayout(layout.groups.filter((_, i) => i !== Number(value)));
      break;
    case 'auto': {
      const locked = layout.groups.filter(group => group.source !== 'auto');
      const lockedIds = new Set(locked.flatMap(group => group.ids));
      const available = layout.cards.filter(item => !lockedIds.has(item.id));
      const automatic = organize(available, view.level_rank).map(combo => ({
        ids: combo.ids, action: combo.action, source: 'auto'
      }));
      setLayout([...locked, ...automatic]);
      break;
    }
    case 'group': {
      if (view.phase !== 'play') break;
      const group = layout.groups[Number(value)];
      selected = new Set(group.ids);
      declaration = group.action;
      render();
      break;
    }
    case 'flush':
      hintChoices = straightFlushes(layout.cards, view.level_rank);
      hintOpen = true;
      render();
      break;
    case 'hint-pick':
      if (view.phase === 'play') pickCombo(hintChoices[Number(value)]);
      break;
    case 'hint-close':
      hintOpen = false;
      render();
      break;
    case 'suggest': {
      const actions = view.legal_combos ?? [];
      const lead = actions.filter(action => action !== 'PASS' && actionCards(action).length === 1);
      pickCombo(weakest(!actions.includes('PASS') && lead.length ? lead : actions, view.level_rank));
      break;
    }
    case 'pass':
      requestAction('PASS');
      break;
    case 'play': {
      const actions = selectionActions();
      const chosen = chosenAction(actions);
      if (chosen) requestAction(chosen);
      break;
    }
    case 'next':
      nextHand();
      break;
  }
});

window.addEventListener('hashchange', route);
route();
