const SUPABASE_URL = 'https://qemgbrppaojknumijzqb.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ySAzxMMTKgmmDbM8UmiC2w_SWaLIB8i';

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// Generate or retrieve a persistent player ID for this browser tab/session
export function getPlayerId() {
  let id = sessionStorage.getItem('imposter_player_id');
  if (!id) {
    id = 'player_' + crypto.randomUUID();
    sessionStorage.setItem('imposter_player_id', id);
  }
  return id;
}

// Fetch public room state
export async function fetchRoom(roomCode) {
  const { data, error } = await supabase
    .from('rooms')
    .select('code, host_id, status, round, max_rounds, category, imposter_clue, secret_word, turn_order, current_turn_index')
    .eq('code', roomCode)
    .single();

  if (error) throw error;
  return data;
}

// Fetch public list of players in the room (without exposing others' roles/words)
export async function fetchPublicPlayers(roomCode) {
  const { data, error } = await supabase
    .from('player_roles')
    .select('room_code, player_id, nickname, avatar_url, is_ready, vote, clues, joined_at')
    .eq('room_code', roomCode)
    .order('joined_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

// Fetch ONLY the current player's secret role and word/clue
export async function fetchMySecret(roomCode, playerId) {
  const { data, error } = await supabase
    .from('player_roles')
    .select('role, word')
    .eq('room_code', roomCode)
    .eq('player_id', playerId)
    .single();

  if (error) throw error;
  return data;
}

// Subscribe to real-time changes on both `rooms` and `player_roles` for this room
export function subscribeToRoom(roomCode, onUpdate) {
  const channel = supabase
    .channel(`room-sync-${roomCode}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'rooms', filter: `code=eq.${roomCode}` },
      () => onUpdate()
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'player_roles', filter: `room_code=eq.${roomCode}` },
      () => onUpdate()
    )
    .subscribe();

  return channel;
}