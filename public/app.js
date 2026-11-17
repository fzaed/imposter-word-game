import {
  supabase,
  getPlayerId,
  fetchRoom,
  fetchPublicPlayers,
  fetchMySecret,
  subscribeToRoom
} from './supabase-client.js';

const playerId = getPlayerId();
let currentRoomCode = null;
let mySecret = { role: null, word: null };
let selectedVoteTarget = null;
let avatarSeed = 'Agent' + Math.floor(Math.random() * 9999);
let roomSubscription = null;

// DOM Helpers
const $ = (id) => document.getElementById(id);

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
  $(screenId).classList.remove('hidden');
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getAvatarUrl(seed) {
  return `https://api.dicebear.com/9.x/bottts/svg?seed=${encodeURIComponent(seed)}`;
}

// Auto-fill room code if opened via ?room=XXXX invite link
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('room')) {
  $('input-room-code').value = urlParams.get('room').toUpperCase().slice(0, 4);
}
$('preview-avatar').src = getAvatarUrl(avatarSeed);

// Reroll Avatar
$('btn-reroll-avatar').addEventListener('click', () => {
  avatarSeed = 'Agent' + Math.floor(Math.random() * 99999);
  $('preview-avatar').src = getAvatarUrl(avatarSeed);
});

// Copy Invite Link
$('btn-copy-link').addEventListener('click', async () => {
  if (!currentRoomCode) return;
  const inviteUrl = `${window.location.origin}/?room=${currentRoomCode}`;
  await navigator.clipboard.writeText(inviteUrl);
  $('btn-copy-link').textContent = '✅';
  setTimeout(() => ($('btn-copy-link').textContent = '📋'), 1500);
});

// Create Room
$('btn-create-room').addEventListener('click', async () => {
  const nickname = $('input-nickname').value.trim();
  if (!nickname) {
    $('home-error').textContent = 'Enter a codename first.';
    return;
  }
  $('home-error').textContent = '';

  const roomCode = generateRoomCode();
  const avatarUrl = getAvatarUrl(avatarSeed);

  const { error: roomErr } = await supabase.from('rooms').insert({
    code: roomCode,
    host_id: playerId,
    status: 'lobby'
  });

  if (roomErr) {
    $('home-error').textContent = roomErr.message;
    return;
  }

  const { error: playerErr } = await supabase.from('player_roles').insert({
    room_code: roomCode,
    player_id: playerId,
    nickname,
    avatar_url: avatarUrl
  });

  if (playerErr) {
    $('home-error').textContent = playerErr.message;
    return;
  }

  enterRoom(roomCode);
});

// Join Room
$('btn-join-room').addEventListener('click', async () => {
  const nickname = $('input-nickname').value.trim();
  const roomCode = $('input-room-code').value.trim().toUpperCase();

  if (!nickname) {
    $('home-error').textContent = 'Enter a codename first.';
    return;
  }
  if (roomCode.length !== 4) {
    $('home-error').textContent = 'Enter a valid 4-letter room code.';
    return;
  }
  $('home-error').textContent = '';

  const { data: room, error: roomErr } = await supabase
    .from('rooms')
    .select('code, status')
    .eq('code', roomCode)
    .single();

  if (roomErr || !room) {
    $('home-error').textContent = 'Room not found.';
    return;
  }
  if (room.status !== 'lobby') {
    $('home-error').textContent = 'Game already in progress.';
    return;
  }

  const avatarUrl = getAvatarUrl(avatarSeed);
  const { error: joinErr } = await supabase.from('player_roles').upsert({
    room_code: roomCode,
    player_id: playerId,
    nickname,
    avatar_url: avatarUrl
  });

  if (joinErr) {
    $('home-error').textContent = joinErr.message;
    return;
  }

  enterRoom(roomCode);
});

async function enterRoom(roomCode) {
  currentRoomCode = roomCode;
  $('display-room-code').textContent = roomCode;
  $('room-badge').classList.remove('hidden');

  if (roomSubscription) supabase.removeChannel(roomSubscription);
  roomSubscription = subscribeToRoom(roomCode, () => syncGameState());
  await syncGameState();
}

// Central State Sync
async function syncGameState() {
  if (!currentRoomCode) return;

  try {
    const [room, players] = await Promise.all([
      fetchRoom(currentRoomCode),
      fetchPublicPlayers(currentRoomCode)
    ]);

    const isHost = room.host_id === playerId;

    // 1. LOBBY
    if (room.status === 'lobby') {
      mySecret = { role: null, word: null };
      selectedVoteTarget = null;
      $('role-card').classList.remove('is-flipped');
      showScreen('screen-lobby');

      $('player-count').textContent = players.length;
      $('lobby-player-list').innerHTML = players
        .map(
          (p) => `
          <li class="player-chip">
            <img src="${p.avatar_url}" alt="${p.nickname}" />
            <span class="name">${p.nickname} ${p.player_id === room.host_id ? '👑' : ''}</span>
          </li>`
        )
        .join('');

      if (isHost) {
        $('host-controls').classList.remove('hidden');
        $('guest-waiting-msg').classList.add('hidden');
        $('btn-start-game').disabled = players.length < 3;
      } else {
        $('host-controls').classList.add('hidden');
        $('guest-waiting-msg').classList.remove('hidden');
      }
      return;
    }

    // Load secret role once game leaves lobby
    if (!mySecret.role) {
      mySecret = await fetchMySecret(currentRoomCode, playerId);
      renderRoleCard();
    }

    // 2. ROLE CARD REVEAL
    if (room.status === 'reveal') {
      showScreen('screen-reveal');
      const readyCount = players.filter((p) => p.is_ready).length;
      const me = players.find((p) => p.player_id === playerId);

      $('btn-ready').disabled = Boolean(me?.is_ready);
      $('btn-ready').textContent = me?.is_ready ? 'Waiting for others...' : 'I Memorized It — Ready';
      $('ready-status').textContent = `${readyCount} / ${players.length} agents ready`;

      // Host advances room to clue_round once everyone is ready
      if (isHost && readyCount === players.length && players.length >= 3) {
        await supabase
          .from('rooms')
          .update({ status: 'clue_round', round: 1, current_turn_index: 0 })
          .eq('code', currentRoomCode);
      }
      return;
    }

    // 3. CLUE TURNS
    if (room.status === 'clue_round') {
      showScreen('screen-turns');
      $('current-round-num').textContent = room.round;
      $('max-round-num').textContent = room.max_rounds;

      const activePlayerId = room.turn_order[room.current_turn_index];
      const activePlayer = players.find((p) => p.player_id === activePlayerId);
      const isMyTurn = activePlayerId === playerId;

      $('active-turn-name').textContent = isMyTurn ? 'YOUR' : activePlayer?.nickname || 'Agent';
      $('turn-banner').classList.toggle('my-turn', isMyTurn);
      $('my-turn-input-box').classList.toggle('hidden', !isMyTurn);

      // Build chronological clue feed across rounds
      const allClues = [];
      players.forEach((p) => {
        (p.clues || []).forEach((c) => {
          allClues.push({ nickname: p.nickname, round: c.round, word: c.word });
        });
      });
      allClues.sort((a, b) => a.round - b.round);

      $('clue-feed').innerHTML =
        allClues.length === 0
          ? `<p class="subtitle" style="text-align:center;">Waiting for first clue...</p>`
          : allClues
              .map(
                (c) => `
              <div class="clue-item">
                <span>R${c.round} • <strong>${c.nickname}</strong></span>
                <span class="clue-word">${c.word}</span>
              </div>`
              )
              .join('');
      return;
    }

    // 4. VOTING
    if (room.status === 'voting') {
      showScreen('screen-voting');
      const me = players.find((p) => p.player_id === playerId);
      const hasVoted = Boolean(me?.vote);

      // Mini clue recap
      const recapHtml = players
        .map((p) => {
          const words = (p.clues || []).map((c) => c.word).join(', ');
          return `<span class="recap-pill"><strong>${p.nickname}:</strong> ${words}</span>`;
        })
        .join('');
      $('voting-clue-recap').innerHTML = recapHtml;

      // Render player vote options
      $('voting-list').innerHTML = players
        .map((p) => {
          const isSelected = (selectedVoteTarget || me?.vote) === p.player_id;
          return `
            <div class="vote-card ${isSelected ? 'selected' : ''}" data-target="${p.player_id}">
              <div style="display:flex;align-items:center;gap:10px;">
                <img src="${p.avatar_url}" style="width:32px;height:32px;border-radius:50%;" />
                <strong>${p.nickname}</strong>
              </div>
              <span>${isSelected ? '🎯' : ''}</span>
            </div>`;
        })
        .join('');

      if (!hasVoted) {
        document.querySelectorAll('.vote-card').forEach((card) => {
          card.addEventListener('click', () => {
            selectedVoteTarget = card.dataset.target;
            $('btn-confirm-vote').disabled = false;
            syncGameState();
          });
        });
      }

      $('btn-confirm-vote').disabled = hasVoted || !selectedVoteTarget;
      const votedCount = players.filter((p) => p.vote).length;
      $('vote-status').textContent = `${votedCount} / ${players.length} votes cast`;

      // Host tallies votes once everyone has voted
      if (isHost && votedCount === players.length) {
        const tally = {};
        players.forEach((p) => {
          tally[p.vote] = (tally[p.vote] || 0) + 1;
        });

        let topId = null;
        let maxVotes = -1;
        Object.entries(tally).forEach(([targetId, count]) => {
          if (count > maxVotes) {
            maxVotes = count;
            topId = targetId;
          }
        });

        // Check if caught player is actually the imposter
        const { data: imposterRow } = await supabase
          .from('player_roles')
          .select('player_id')
          .eq('room_code', currentRoomCode)
          .eq('role', 'imposter')
          .single();

        const imposterCaught = topId === imposterRow?.player_id;
        await supabase
          .from('rooms')
          .update({ status: imposterCaught ? 'guess' : 'over' })
          .eq('code', currentRoomCode);
      }
      return;
    }

    // 5. IMPOSTER LAST CHANCE GUESS OR FINAL RESULTS
    if (room.status === 'guess' || room.status === 'over') {
      showScreen('screen-results');

      const { data: imposterRow } = await supabase
        .from('player_roles')
        .select('player_id, nickname')
        .eq('room_code', currentRoomCode)
        .eq('role', 'imposter')
        .single();

      const amImposter = mySecret.role === 'imposter';

      if (room.status === 'guess') {
        $('result-headline').textContent = 'Imposter Caught!';
        $('result-subtext').textContent = amImposter
          ? 'You were voted out—guess the secret word to steal the victory!'
          : `Waiting for ${imposterRow?.nickname} to make their final word guess...`;
        $('imposter-guess-box').classList.toggle('hidden', !amImposter);
        $('reveal-imposter-name').textContent = imposterRow?.nickname || '---';
        $('reveal-secret-word').textContent = amImposter ? '???' : room.secret_word;
        $('btn-play-again').classList.add('hidden');
      } else {
        $('imposter-guess-box').classList.add('hidden');
        $('result-headline').textContent = 'Mission Over';
        $('result-subtext').textContent = 'Review the final dossier below.';
        $('reveal-imposter-name').textContent = imposterRow?.nickname || '---';
        $('reveal-secret-word').textContent = room.secret_word || '---';
        $('btn-play-again').classList.toggle('hidden', !isHost);
      }
    }
  } catch (err) {
    console.error('Sync error:', err);
  }
}

// Render 3D Card Content
function renderRoleCard() {
  const front = $('role-card-front');
  front.classList.remove('card-civilian', 'card-imposter');

  if (mySecret.role === 'imposter') {
    front.classList.add('card-imposter');
    $('card-role-tag').textContent = 'IMPOSTER';
    $('card-secret-caption').textContent = 'YOUR ONLY CLUE';
    $('card-secret-value').textContent = mySecret.word.replace(/^Clue:\s*/i, '');
    $('card-tip').textContent = 'Listen to others, blend in, and figure out the exact word.';
  } else {
    front.classList.add('card-civilian');
    $('card-role-tag').textContent = 'CIVILIAN';
    $('card-secret-caption').textContent = 'SECRET WORD';
    $('card-secret-value').textContent = mySecret.word;
    $('card-tip').textContent = 'Give one-word clues without handing the word to the Imposter.';
  }
}

// Flip Card Interaction
$('role-card-wrapper').addEventListener('click', () => {
  $('role-card').classList.toggle('is-flipped');
});

// Start Game (Host)
$('btn-start-game').addEventListener('click', async () => {
  $('btn-start-game').disabled = true;
  $('lobby-error').textContent = '';

  const res = await fetch('/api/start-game', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomCode: currentRoomCode,
      hostId: playerId,
      category: $('select-category').value,
      maxRounds: $('select-rounds').value
    })
  });

  const data = await res.json();
  if (!res.ok) {
    $('lobby-error').textContent = data.error || 'Failed to start game';
    $('btn-start-game').disabled = false;
  }
});

// Ready Button
$('btn-ready').addEventListener('click', async () => {
  $('btn-ready').disabled = true;
  await supabase
    .from('player_roles')
    .update({ is_ready: true })
    .eq('room_code', currentRoomCode)
    .eq('player_id', playerId);
});

// Submit One-Word Clue
$('btn-submit-clue').addEventListener('click', async () => {
  const raw = $('input-clue').value.trim();
  if (!raw) return;
  if (/\s/.test(raw)) {
    $('clue-error').textContent = 'One word only — no spaces allowed!';
    return;
  }
  $('clue-error').textContent = '';
  $('btn-submit-clue').disabled = true;

  const [room, players] = await Promise.all([
    fetchRoom(currentRoomCode),
    fetchPublicPlayers(currentRoomCode)
  ]);

  const me = players.find((p) => p.player_id === playerId);
  const updatedClues = [...(me.clues || []), { round: room.round, word: raw }];

  await supabase
    .from('player_roles')
    .update({ clues: updatedClues })
    .eq('room_code', currentRoomCode)
    .eq('player_id', playerId);

  // Advance turn or round
  let nextIndex = room.current_turn_index + 1;
  let nextRound = room.round;
  let nextStatus = 'clue_round';

  if (nextIndex >= room.turn_order.length) {
    nextIndex = 0;
    nextRound += 1;
    if (nextRound > room.max_rounds) {
      nextStatus = 'voting';
    }
  }

  await supabase
    .from('rooms')
    .update({
      current_turn_index: nextIndex,
      round: nextRound,
      status: nextStatus
    })
    .eq('code', currentRoomCode);

  $('input-clue').value = '';
  $('btn-submit-clue').disabled = false;
});

// Peek Modal
$('btn-peek-card').addEventListener('click', () => {
  $('peek-role-label').textContent = mySecret.role === 'imposter' ? 'IMPOSTER CLUE' : 'SECRET WORD';
  $('peek-secret-text').textContent = mySecret.word?.replace(/^Clue:\s*/i, '') || '---';
  $('peek-modal').classList.remove('hidden');
});

$('btn-close-peek').addEventListener('click', () => {
  $('peek-modal').classList.add('hidden');
});

// Confirm Vote
$('btn-confirm-vote').addEventListener('click', async () => {
  if (!selectedVoteTarget) return;
  $('btn-confirm-vote').disabled = true;

  await supabase
    .from('player_roles')
    .update({ vote: selectedVoteTarget })
    .eq('room_code', currentRoomCode)
    .eq('player_id', playerId);
});

// Submit Imposter Final Guess
$('btn-submit-guess').addEventListener('click', async () => {
  const guess = $('input-final-guess').value.trim();
  if (!guess) return;
  $('btn-submit-guess').disabled = true;

  const res = await fetch('/api/check-guess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomCode: currentRoomCode,
      playerId,
      guess
    })
  });

  const data = await res.json();
  if (res.ok) {
    $('imposter-guess-box').classList.add('hidden');
    $('result-headline').textContent = data.correct
      ? 'Imposter Stole the Win!'
      : 'Wrong Guess — Civilians Win!';
  }
});

// Play Again (Host resets room to lobby)
$('btn-play-again').addEventListener('click', async () => {
  await supabase
    .from('rooms')
    .update({ status: 'lobby', secret_word: null, imposter_clue: null })
    .eq('code', currentRoomCode);
});

// Leave Room
$('btn-leave-room').addEventListener('click', () => {
  window.location.href = window.location.pathname;
});