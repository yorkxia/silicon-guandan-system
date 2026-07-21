/* ══════════════════════════════════════════════════════════════
 * GDCard —— 高清矢量扑克牌渲染器（离线内联 SVG，任意分辨率都锐利）
 * 统一供 4 人 / 6 人大屏使用，替代旧的文字牌。
 *   GDCard.faceSVG(code)  → 正面牌 SVG 字符串
 *   GDCard.backSVG()      → 牌背 SVG 字符串
 * code: 'S3' 'HT'(10) 'DA' 'CK' 'BJ'(大王) 'LJ'(小王)
 * viewBox 固定 0 0 240 336（5:7），由外层 width/height 决定实际尺寸。
 * ════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var W = 240, H = 336;
  var RED = '#D4001C', BLACK = '#1b1b2b';

  /* 四种花色矢量路径（100×100 视框，居中约 50,50）*/
  var SUIT_PATH = {
    S: 'M50 6 C60 30 92 40 92 62 C92 78 78 85 66 82 C60 80 55 75 53 69 C54 80 58 88 66 96 L34 96 C42 88 46 80 47 69 C45 75 40 80 34 82 C22 85 8 78 8 62 C8 40 40 30 50 6 Z',
    H: 'M50 92 C16 66 8 46 8 32 C8 16 20 8 32 8 C42 8 49 15 50 25 C51 15 58 8 68 8 C80 8 92 16 92 32 C92 46 84 66 50 92 Z',
    D: 'M50 4 L88 50 L50 96 L12 50 Z',
    C: 'M50 6 C62 6 71 15 71 27 C71 33 68 38 64 42 C71 37 80 37 86 43 C94 51 93 63 85 70 C78 76 67 74 60 68 C56 65 54 61 53 56 C54 68 58 80 66 96 L34 96 C42 80 46 68 47 56 C46 61 44 65 40 68 C33 74 22 76 15 70 C7 63 6 51 14 43 C20 37 29 37 36 42 C32 38 29 33 29 27 C29 15 38 6 50 6 Z'
  };
  var SUIT_UNI = { S: '♠', H: '♥', D: '♦', C: '♣' };

  function colorOf(suit) { return (suit === 'H' || suit === 'D') ? RED : BLACK; }

  /* 一枚花色符号：把 100×100 路径缩放到 size，放到 (cx,cy)，flip=上下翻转 */
  function pip(suit, cx, cy, size, color, flip) {
    var s = size / 100;
    var t = 'translate(' + cx + ',' + cy + ') scale(' + s + (flip ? ',' + (-s) : ',' + s) + ') translate(-50,-50)';
    return '<path d="' + SUIT_PATH[suit] + '" fill="' + color + '" transform="' + t + '"/>';
  }

  /* 标准点数牌花色布局：列 L/C/R，行按牌高比例；下半区翻转 */
  var COL = { L: 0.30 * W, C: 0.50 * W, R: 0.70 * W };
  var LAYOUT = {
    '2':  [['C', 0.26], ['C', 0.74]],
    '3':  [['C', 0.26], ['C', 0.50], ['C', 0.74]],
    '4':  [['L', 0.26], ['R', 0.26], ['L', 0.74], ['R', 0.74]],
    '5':  [['L', 0.26], ['R', 0.26], ['C', 0.50], ['L', 0.74], ['R', 0.74]],
    '6':  [['L', 0.26], ['R', 0.26], ['L', 0.50], ['R', 0.50], ['L', 0.74], ['R', 0.74]],
    '7':  [['L', 0.26], ['R', 0.26], ['C', 0.38], ['L', 0.50], ['R', 0.50], ['L', 0.74], ['R', 0.74]],
    '8':  [['L', 0.26], ['R', 0.26], ['C', 0.38], ['L', 0.50], ['R', 0.50], ['C', 0.62], ['L', 0.74], ['R', 0.74]],
    '9':  [['L', 0.24], ['R', 0.24], ['L', 0.42], ['R', 0.42], ['C', 0.50], ['L', 0.58], ['R', 0.58], ['L', 0.76], ['R', 0.76]],
    '10': [['L', 0.24], ['R', 0.24], ['C', 0.33], ['L', 0.42], ['R', 0.42], ['L', 0.58], ['R', 0.58], ['C', 0.67], ['L', 0.76], ['R', 0.76]]
  };

  /* 角标：点数 + 小花色（左上，右下镜像旋转 180°）*/
  function corner(rankTxt, suit, color) {
    var fs = rankTxt.length > 1 ? 34 : 40;        // “10” 略小
    var g =
      '<text x="0" y="0" font-family="Arial,\'Helvetica Neue\',sans-serif" font-weight="800" ' +
      'font-size="' + fs + '" fill="' + color + '" text-anchor="middle">' + rankTxt + '</text>' +
      pip(suit, 0, 40, 30, color, false);
    return '<g transform="translate(30,44)">' + g + '</g>' +
           '<g transform="translate(' + (W - 30) + ',' + (H - 44) + ') rotate(180)">' + g + '</g>';
  }

  /* J/Q/K：清爽的宫廷牌——双线内框 + 大字母 + 四角花色 */
  function faceCard(rankTxt, suit, color) {
    var cx = W / 2, cy = H / 2;
    var panel =
      '<rect x="58" y="72" width="124" height="192" rx="10" fill="none" stroke="' + color + '" stroke-width="3"/>' +
      '<rect x="66" y="80" width="108" height="176" rx="7" fill="none" stroke="' + color + '" stroke-width="1.5" opacity=".55"/>';
    var letter =
      '<text x="' + cx + '" y="' + (cy + 34) + '" font-family="Georgia,\'Times New Roman\',serif" ' +
      'font-weight="700" font-size="110" fill="' + color + '" text-anchor="middle" opacity=".92">' + rankTxt + '</text>';
    var pips =
      pip(suit, 82, 100, 26, color, false) + pip(suit, W - 82, 100, 26, color, false) +
      pip(suit, 82, H - 100, 26, color, true) + pip(suit, W - 82, H - 100, 26, color, true);
    return panel + letter + pips;
  }

  /* 王牌 */
  function joker(big) {
    var color = big ? RED : BLACK;
    var txt = big ? '大王' : '小王';   // 大王 / 小王
    var star =
      '<path transform="translate(120,150) scale(1.5)" fill="' + color + '" ' +
      'd="M0 -34 L9 -11 L34 -11 L14 4 L21 28 L0 14 L-21 28 L-14 4 L-34 -11 L-9 -11 Z"/>';
    var label = txt.split('').map(function (ch, i) {
      return '<text x="120" y="' + (210 + i * 46) + '" font-family="\'PingFang SC\',\'Microsoft YaHei\',sans-serif" ' +
        'font-weight="900" font-size="42" fill="' + color + '" text-anchor="middle">' + ch + '</text>';
    }).join('');
    var jk = '<text x="120" y="86" font-family="Arial,sans-serif" font-weight="800" font-size="26" ' +
      'fill="' + color + '" text-anchor="middle" letter-spacing="2">JOKER</text>';
    return jk + star + label;
  }

  function shell(inner) {
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" ' +
      'style="display:block;width:100%;height:100%" preserveAspectRatio="xMidYMid meet">' +
      '<defs><linearGradient id="gdcw" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f2f4f8"/></linearGradient></defs>' +
      '<rect x="1.5" y="1.5" width="' + (W - 3) + '" height="' + (H - 3) + '" rx="18" ry="18" ' +
      'fill="url(#gdcw)" stroke="#c9ced8" stroke-width="1.5"/>' +
      '<rect x="1.5" y="1.5" width="' + (W - 3) + '" height="' + (H - 3) + '" rx="18" ry="18" ' +
      'fill="none" stroke="rgba(0,0,0,.10)" stroke-width="1"/>' +
      inner + '</svg>';
  }

  function faceSVG(code) {
    if (code === 'BJ') return shell(joker(true));
    if (code === 'LJ') return shell(joker(false));
    var suit = code[0], rank = code.slice(1);
    var color = colorOf(suit);
    var rankTxt = rank === 'T' ? '10' : rank;
    var body;
    if (rank === 'J' || rank === 'Q' || rank === 'K') {
      body = faceCard(rankTxt, suit, color);
    } else if (rank === 'A') {
      body = pip(suit, W / 2, H / 2, 96, color, false);
    } else {
      var lay = LAYOUT[rankTxt] || [];
      body = lay.map(function (p) {
        return pip(suit, COL[p[0]], p[1] * H, 40, color, p[1] > 0.5);
      }).join('');
    }
    return shell(corner(rankTxt, suit, color) + body);
  }

  function backSVG() {
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" ' +
      'style="display:block;width:100%;height:100%" preserveAspectRatio="xMidYMid meet">' +
      '<defs><linearGradient id="gdcb" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#2a5db0"/><stop offset="1" stop-color="#123a7a"/></linearGradient>' +
      '<pattern id="gdcbp" width="26" height="26" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      '<rect width="26" height="26" fill="none"/><circle cx="13" cy="13" r="4" fill="rgba(255,255,255,.16)"/></pattern></defs>' +
      '<rect x="1.5" y="1.5" width="' + (W - 3) + '" height="' + (H - 3) + '" rx="18" fill="url(#gdcb)" stroke="#fff" stroke-width="4"/>' +
      '<rect x="14" y="14" width="' + (W - 28) + '" height="' + (H - 28) + '" rx="10" fill="url(#gdcbp)" stroke="rgba(255,255,255,.4)" stroke-width="2"/>' +
      '<text x="120" y="184" font-family="\'PingFang SC\',sans-serif" font-weight="900" font-size="40" fill="rgba(255,255,255,.85)" text-anchor="middle">掼蛋</text>' +
      '</svg>';
  }

  global.GDCard = { faceSVG: faceSVG, backSVG: backSVG, RED: RED, BLACK: BLACK };
})(typeof window !== 'undefined' ? window : this);
