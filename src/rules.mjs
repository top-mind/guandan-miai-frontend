export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';
export const suitMark = { c: '♣', d: '♦', h: '♥', s: '♠' };
export const SEATS = ['P0', 'P1', 'P2', 'P3'];
export const rankLabel = rank => ({ T: '10', B: '小王', R: '大王' })[rank] ?? rank ?? '—';
export const faceLabel = card => card.endsWith('j')
  ? rankLabel(card[0])
  : rankLabel(card[0]) + suitMark[card[1]];

export function rankPower(rank, level) {
  if (rank === 'R') return 15;
  if (rank === 'B') return 14;
  if (rank === level) return 13;
  return RANKS.indexOf(rank);
}

export function sortHand(hand, level) {
  return [...hand].sort((a, b) => rankPower(b.face[0], level) - rankPower(a.face[0], level)
    || Number(b.face === level + 'h') - Number(a.face === level + 'h')
    || SUITS.indexOf(b.face[1]) - SUITS.indexOf(a.face[1])
    || a.id - b.id);
}

const consecutive = (length, copies) => Array.from(
  { length: RANKS.length + 2 - length },
  (_, i) => ('A' + RANKS).slice(i, i + length).split('').map(rank => rank.repeat(copies)).join('')
);

const straights = consecutive(5, 1);
const pairs = consecutive(3, 2);
const triples = consecutive(2, 3);
const flushes = straights.flatMap(shape => [...SUITS].map(suit => shape + suit));
const sets = [...RANKS].flatMap(rank => Array.from({ length: 9 }, (_, i) => rank.repeat(i + 2)));
const fullHouses = [...RANKS].flatMap(rank => [...RANKS + 'BR']
  .filter(pair => pair !== rank).map(pair => rank.repeat(3) + pair.repeat(2)));
const patterns = ['BjBjRjRj', ...flushes, ...sets, 'BB', 'RR', ...triples, ...pairs, ...straights, ...fullHouses];

export const cardKey = cards => [...cards].sort().join('');
export const actionCards = action => action === 'PASS' ? [] : action.split(':').at(-1).match(/.{2}/g) ?? [];

export function describe(action, level) {
  const cards = actionCards(action);
  const [shape] = action.split(':');
  if (action === 'PASS') return { action, cards, name: '不出', power: -1, bomb: 0 };
  if (cards.length === 1) {
    const rank = shape.length === 1 ? shape : cards[0][0];
    return { action, cards, name: '单张 ' + rankLabel(rank), power: rankPower(rank, level), bomb: 0 };
  }

  const suited = SUITS.includes(shape.at(-1));
  const ranks = suited ? shape.slice(0, -1) : shape;
  const rank = ranks[0];
  let power = rankPower(rank, level);
  let bomb = 0;
  let name;
  if (shape === 'BjBjRjRj') {
    name = '四王炸';
    bomb = 20;
  } else if (suited) {
    name = '同花顺 ' + suitMark[shape.at(-1)] + ' ' + ranks;
    bomb = 6;
    power = straights.indexOf(ranks);
  } else if ([...ranks].every(value => value === rank)) {
    name = (['', '', '对子', '三张'][cards.length] ?? cards.length + ' 张炸弹') + ' ' + rankLabel(rank);
    if (cards.length >= 4) bomb = cards.length < 6 ? cards.length : cards.length + 1;
  } else if (cards.length === 5 && ranks[0] === ranks[2]) {
    name = '三带二 ' + rankLabel(rank) + ' 带 ' + rankLabel(ranks.at(-1));
  } else {
    const order = cards.length === 5 ? straights : rank === ranks[2] ? triples : pairs;
    name = (order === straights ? '顺子' : order === triples ? '钢板' : '三连对') + ' ' + ranks;
    power = order.indexOf(ranks);
  }
  return { action, cards, name, power, bomb };
}

export function weakest(actions, level) {
  return actions.filter(action => action !== 'PASS').map(action => describe(action, level))
    .sort((a, b) => a.bomb - b.bomb || a.power - b.power
      || a.cards.filter(face => face === level + 'h').length - b.cards.filter(face => face === level + 'h').length
      || a.cards.length - b.cards.length || a.action.localeCompare(b.action))[0];
}

function fillPattern(shape, hand, level) {
  const suited = SUITS.includes(shape.at(-1));
  const suit = suited ? shape.at(-1) : null;
  const ranks = suited ? shape.slice(0, -1) : shape;
  const fullHouse = ranks.length === 5 && ranks[0] === ranks[2] && ranks[3] !== ranks[2];
  const slots = shape === 'BjBjRjRj' ? ['B', 'B', 'R', 'R']
    : fullHouse ? [...ranks] : [...ranks].reverse();
  const wild = level + 'h';
  const pool = [...hand];
  const cards = slots.map(rank => {
    const index = pool.findIndex(card => card.face !== wild && card.face[0] === rank
      && (!suit || card.face[1] === suit));
    return index < 0 ? null : pool.splice(index, 1)[0];
  });
  for (const [index, card] of cards.entries()) {
    if (card) continue;
    if ('BR'.includes(slots[index])) return null;
    const wildcard = pool.findIndex(item => item.face === wild);
    if (wildcard < 0) return null;
    cards[index] = pool.splice(wildcard, 1)[0];
  }
  return { ...describe(shape + ':' + cards.map(card => card.face).join(''), level), ids: cards.map(card => card.id) };
}

export function identify(hand, level) {
  if (!hand.length) return [];
  if (hand.length === 1) return [{ ...describe(hand[0].face, level), ids: [hand[0].id] }];
  return patterns.flatMap(shape => {
    const length = shape === 'BjBjRjRj' ? 4 : shape.length - Number(SUITS.includes(shape.at(-1)));
    if (length !== hand.length) return [];
    const result = fillPattern(shape, hand, level);
    return result ? [result] : [];
  });
}

export function straightFlushes(hand, level) {
  return flushes.map(shape => fillPattern(shape, hand, level)).filter(Boolean)
    .sort((a, b) => b.power - a.power || a.action.localeCompare(b.action));
}

export function organize(hand, level) {
  let pool = sortHand(hand, level);
  const groups = [];
  while (pool.length > 1) {
    const choices = patterns.map(shape => fillPattern(shape, pool, level)).filter(Boolean);
    const wilds = item => item.cards.filter(face => face === level + 'h').length;
    choices.sort((a, b) => b.bomb - a.bomb || (b.cards.length - wilds(b)) - (a.cards.length - wilds(a))
      || wilds(a) - wilds(b) || b.cards.length - a.cards.length || b.power - a.power);
    const best = choices[0];
    if (!best) break;
    // Keep loose pairs and triples in the default rank stacks.
    if (!best.bomb && best.cards.length < 5) break;
    groups.push(best);
    pool = pool.filter(card => !best.ids.includes(card.id));
  }
  return groups;
}

export function outsideCounts(hand, events) {
  const counts = Object.fromEntries([...RANKS].flatMap(rank => [...SUITS].map(suit => [rank + suit, 2])));
  counts.Bj = counts.Rj = 2;
  for (const face of [...hand, ...events.flatMap(event => event.cards ?? [])]) {
    if (face in counts) counts[face] = Math.max(0, counts[face] - 1);
  }
  return counts;
}

export function wildcardRoles(action, level) {
  if (action === 'PASS' || !action.includes(':')) return [];
  const cards = actionCards(action);
  const shape = action.split(':')[0];
  const suited = SUITS.includes(shape.at(-1));
  const ranks = suited ? shape.slice(0, -1) : shape;
  const fullHouse = ranks.length === 5 && ranks[0] === ranks[2] && ranks[3] !== ranks[2];
  const slots = fullHouse ? [...ranks] : [...ranks].reverse();
  return cards.map((face, index) => {
    if (face !== level + 'h' || !slots[index]) return null;
    const rank = slots[index];
    const suit = suited ? suitMark[shape.at(-1)] : '';
    return rank === level && !suited ? null : rankLabel(rank) + suit;
  });
}

export function exposedCards(view, seat) {
  const shown = [];
  function remove(face) {
    const index = shown.indexOf(face);
    if (index !== -1) shown.splice(index, 1);
  }
  for (const transfer of view.tribute?.transfers ?? []) {
    if (transfer.from === seat) remove(transfer.card);
    if (transfer.to === seat) shown.push(transfer.card);
  }
  for (const event of view.events ?? []) {
    if (event.seat === seat) (event.cards ?? []).forEach(remove);
  }
  return shown.slice(0, view.hand_sizes?.[seat] ?? shown.length);
}
