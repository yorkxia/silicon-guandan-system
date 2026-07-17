/* 掼蛋发牌引擎 · 108张两副牌 */

const crypto = require('crypto');

/* 密码学安全随机整数 [0, max)（底层：Windows=CryptGenRandom / Linux=/dev/urandom）
   规范要求禁用 Math.random()，改用操作系统 CSPRNG 保证发牌不可预测。 */
function secureRandomInt(max) {
  return crypto.randomInt(max);
}

const SUITS = ['S', 'H', 'D', 'C']; // ♠♥♦♣
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];

/* 单副54张 */
function createDeck() {
  const cards = [];
  for (const s of SUITS) for (const r of RANKS) cards.push(s + r);
  cards.push('LJ'); // 小王
  cards.push('BJ'); // 大王
  return cards;
}

/* 两副108张 */
function createDoubleDeck() {
  return [...createDeck(), ...createDeck()];
}

/* 三副162张（六人掼蛋专用） */
function createTripleDeck() {
  return [...createDeck(), ...createDeck(), ...createDeck()];
}

/* Fisher-Yates 洗牌（CSPRNG 版）
   倒序遍历 107→1，每步在 [0,i] 内用 CSPRNG 取随机索引交换，
   保证 108 张牌所有排列等概率、且序列不可预测。 */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* 发给4个玩家，各27张 */
function deal4(deck) {
  return [
    deck.slice(0,  27),
    deck.slice(27, 54),
    deck.slice(54, 81),
    deck.slice(81, 108)
  ];
}

/* 发给6个玩家，各27张（从162张三副牌发） */
function deal6(deck) {
  return [
    deck.slice(0,   27),
    deck.slice(27,  54),
    deck.slice(54,  81),
    deck.slice(81,  108),
    deck.slice(108, 135),
    deck.slice(135, 162)
  ];
}

/* ── 排序（用于手牌显示） ──
   大王 > 小王 > A > K > Q > J > 10…2
   同点数按花色：♠ > ♥ > ♦ > ♣
*/
const RANK_VAL  = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };
const SUIT_VAL  = { S:4, H:3, D:2, C:1 };

function rankVal(card) {
  if (card === 'BJ') return 16;
  if (card === 'LJ') return 15;
  return RANK_VAL[card.slice(1)] || 0;
}

function sortHand(hand) {
  return [...hand].sort((a, b) => {
    const rv = rankVal(b) - rankVal(a);
    if (rv !== 0) return rv;
    return (SUIT_VAL[b[0]] || 0) - (SUIT_VAL[a[0]] || 0);
  });
}

/* ── 客户端可直接使用的展示信息 ── */
const SUIT_SYM   = { S:'♠', H:'♥', D:'♦', C:'♣' };
const SUIT_COLOR = { S:'#1a1a2e', H:'#C0000F', D:'#C0000F', C:'#1a1a2e' };
const RANK_DISP  = { T:'10' };

function cardInfo(code) {
  if (code === 'BJ') return { top:'大', bot:'王', color:'#D4AC0D', bg:'#FFF8E0', joker:true };
  if (code === 'LJ') return { top:'小', bot:'王', color:'#666',    bg:'#F5F5F5', joker:true };
  const suit = code[0], rank = code.slice(1);
  return {
    top:   RANK_DISP[rank] || rank,
    bot:   SUIT_SYM[suit],
    color: SUIT_COLOR[suit],
    bg:    '#fff',
    suit,
    rank
  };
}

module.exports = { createDoubleDeck, createTripleDeck, shuffle, deal4, deal6, sortHand, cardInfo, rankVal };
