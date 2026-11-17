import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { WORD_BANK } from '../lib/wordBank.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { roomCode, hostId, category = 'All Categories', maxRounds = 2 } = req.body;

    // 1. Fetch room & verify host
    const { data: room, error: roomErr } = await supabaseAdmin
      .from('rooms')
      .select('*')
      .eq('code', roomCode)
      .single();

    if (roomErr || !room) return res.status(404).json({ error: 'Room not found' });
    if (room.host_id !== hostId) return res.status(403).json({ error: 'Only host can start' });

    // 2. Fetch players in room
    const { data: players, error: playersErr } = await supabaseAdmin
      .from('player_roles')
      .select('*')
      .eq('room_code', roomCode);

    if (playersErr || players.length < 3) {
      return res.status(400).json({ error: 'Need at least 3 players to start' });
    }

    // 3. Filter word bank by category & exclude already used words
    const usedWords = room.used_words || [];
    let pool = WORD_BANK.filter(
      (item) =>
        (category === 'All Categories' || item.category === category) &&
        !usedWords.includes(item.word)
    );
    if (pool.length === 0) pool = WORD_BANK;

    const chosen = pool[Math.floor(Math.random() * pool.length)];

    // 4. Randomly pick 1 imposter & shuffle turn order
    const shuffledIds = players.map((p) => p.player_id).sort(() => Math.random() - 0.5);
    const imposterId = shuffledIds[Math.floor(Math.random() * shuffledIds.length)];

    // 5. Update each player's secret role in Supabase
    for (const player of players) {
      const isImposter = player.player_id === imposterId;
      await supabaseAdmin
        .from('player_roles')
        .update({
          role: isImposter ? 'imposter' : 'civilian',
          word: isImposter ? `Clue: ${chosen.clue}` : chosen.word,
          is_ready: false,
          vote: null,
          clues: []
        })
        .eq('room_code', roomCode)
        .eq('player_id', player.player_id);
    }

    // 6. Update room state to 'reveal'
    await supabaseAdmin
      .from('rooms')
      .update({
        status: 'reveal',
        round: 1,
        max_rounds: Number(maxRounds),
        category,
        secret_word: chosen.word,
        imposter_clue: chosen.clue,
        used_words: [...usedWords, chosen.word],
        turn_order: shuffledIds,
        current_turn_index: 0
      })
      .eq('code', roomCode);

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}