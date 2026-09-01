/* 控制台「是否进贡」开关：按房型(4人/6人 × 随机/亲友)决定本局是否进贡还供。
   - 键名 gd_settings.skey = gdo_tribute_<4p|6p>_<random|private>
   - 默认「进贡」(保持现有供还模式)；仅当管理员在监控台显式设为 '0' 才「不进贡」。
   - 不进贡时：不供不还，改由本局头游(第一个走完者)先出——复用游戏内「抗贡」效果。 */
const { queryOne } = require('../db/init');

/* 是否进贡：true=保持进贡还供(默认)；false=不进贡(头游先出) */
async function tributeEnabled(mode, roomType) {
  const m = (mode === '6p') ? '6p' : '4p';
  const t = (roomType === 'private') ? 'private'
          : (roomType === 'random')  ? 'random'
          : null;
  if (!t) return true;   // tournament / 未知房型 → 默认进贡
  try {
    const row = await queryOne('SELECT sval FROM gd_settings WHERE skey=$1', ['gdo_tribute_' + m + '_' + t]);
    return !row || row.sval !== '0';   // 缺省或非 '0' = 进贡；'0' = 不进贡
  } catch (e) {
    return true;   // 读取失败 → 安全默认：进贡
  }
}

/* 结算时生成写入下局的 tribute_json：
   · 过A重开 → null（不进贡）
   · 不进贡模式 → { noTribute:true, headPlayerId }（下局由头游先出）
   · 末游与头游同队(该局规则上本就不用进贡，如"末胜") → 同样 { noTribute:true }，
     否则 exchanges 为空时 tribute_json 写 null，下局没人显式安排先出座位，
     会退回"座位数组第一个座位先出"这种和上局胜负毫无关系的随机结果。
   · 正常 → 走 computeTribute 的供还信息 */
async function buildTributeJson(state, result, adj, mode, roomType, computeTribute) {
  if (adj.guoA) return null;
  const head = state.finishOrder && state.finishOrder[0];
  const enabled = await tributeEnabled(mode, roomType);
  if (!enabled) {
    return head ? JSON.stringify({ noTribute: true, headPlayerId: head.playerId, delta: result.delta }) : null;
  }
  const tributeInfo = computeTribute(state.finishOrder, result.winnerTeam);
  if (tributeInfo.exchanges.length > 0) return JSON.stringify({ ...tributeInfo, delta: result.delta });
  return head ? JSON.stringify({ noTribute: true, headPlayerId: head.playerId, delta: result.delta }) : null;
}

module.exports = { tributeEnabled, buildTributeJson };
