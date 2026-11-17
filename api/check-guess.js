import { supabaseAdmin } from '../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { roomCode, playerId, guess } = req.body;

    const { data: room, error } = await supabaseAdmin
      .from('rooms')
      .select('secret_word')
      .eq('code', roomCode)
      .single();

    if (error || !room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const correct =
      guess.trim().toLowerCase() === room.secret_word.trim().toLowerCase();

    await supabaseAdmin
      .from('rooms')
      .update({ status: 'over' })
      .eq('code', roomCode);

    return res.status(200).json({ correct });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}