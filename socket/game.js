/* 掼蛋网上赛事 · 游戏桌面 Socket 事件 */
const { query, queryOne } = require('../db/init');
const { sortHand } = require('../utils/cards');

module.exports = function(io, socket) {

  /* 玩家进入游戏页面后请求自己的手牌 */
  socket.on('game:request_hand', async function(data) {
    try {
      const { token, roomCode } = data;

      /* 找到玩家记录 */
      const player = await queryOne(
        'SELECT id FROM gdo_players WHERE player_token=$1', [token]
      );
      if (!player) return socket.emit('game:error', { message: '玩家身份未找到，请返回重试' });

      /* 找到座位 */
      const seat = await queryOne(`
        SELECT s.*, r.game_mode, r.status, r.id AS room_id,
               r.level_team1, r.level_team2, r.round_count
        FROM gdo_seats s
        JOIN gdo_rooms r ON r.id = s.room_id
        WHERE r.room_code=$1 AND s.player_id=$2
      `, [roomCode, player.id]);
      if (!seat) return socket.emit('game:error', { message: '您不在此房间中' });

      /* 更新 socket_id（断线重连） */
      await query('UPDATE gdo_seats SET socket_id=$1, is_connected=TRUE WHERE id=$2',
        [socket.id, seat.id]);
      socket.join(roomCode);

      /* 找到最新一局的手牌 */
      const round = await queryOne(`
        SELECT * FROM gdo_rounds
        WHERE room_id=$1 ORDER BY round_number DESC LIMIT 1
      `, [seat.room_id]);
      if (!round || !round.hands_json) {
        return socket.emit('game:error', { message: '手牌尚未发放，请稍候' });
      }

      const hands = typeof round.hands_json === 'string'
        ? JSON.parse(round.hands_json) : round.hands_json;
      const myHand = sortHand(hands[String(player.id)] || []);

      /* 取所有座位玩家信息（用于桌面显示，但不暴露其他人手牌） */
      const allSeats = await query(`
        SELECT s.seat, s.team, s.is_ready, s.is_connected, p.display_name, p.id AS pid,
               p.player_token
        FROM gdo_seats s JOIN gdo_players p ON p.id=s.player_id
        WHERE s.room_id=$1 ORDER BY s.seat
      `, [seat.room_id]);

      const players = allSeats.map(s => ({
        seat:      s.seat,
        team:      s.team,
        name:      s.display_name,
        cardCount: hands[String(s.pid)] ? hands[String(s.pid)].length : 0,
        isMe:      s.player_token === token,
        connected: s.is_connected
      }));

      socket.emit('game:hand', {
        hand:        myHand,
        mySeat:      seat.seat,
        myTeam:      seat.team,
        gameMode:    seat.game_mode,
        roomCode,
        roundNumber: round.round_number,
        roundId:     round.id,
        levelTeam1:  seat.level_team1,
        levelTeam2:  seat.level_team2,
        players
      });

    } catch (e) {
      console.error('[game:request_hand]', e.message);
      socket.emit('game:error', { message: '获取手牌失败，请刷新重试' });
    }
  });

};
