(() => {
  'use strict';

  const cfg = window.SCRIBBLE_CONFIG || {};
  const configured = cfg.SUPABASE_URL && cfg.SUPABASE_KEY && !cfg.SUPABASE_URL.includes('PASTE_') && !cfg.SUPABASE_KEY.includes('PASTE_');
  const $ = (id) => document.getElementById(id);
  const state = {
    client: null, user: null, room: null, players: [], strokes: [], secret: null,
    roomChannel: null, selectedVote: null, voted: false,
    drawing: false, draftPoints: [], draftReady: false, remoteDraft: null,
    secretVisible: true, lastBroadcast: 0
  };

  function setError(where, message='') {
    const el = $(where);
    el.textContent = message;
    el.classList.toggle('hidden', !message);
  }
  function friendlyError(error) {
    const msg = error?.message || String(error || 'Unbekannter Fehler');
    return msg.replace(/^.*?exception:\s*/i,'').replace(/^.*?message:\s*/i,'');
  }
  function setConnected(text, good=false) {
    $('connectionBadge').textContent = text;
    $('connectionBadge').style.color = good ? '#c8ffef' : '';
  }
  function showView(id) {
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === id));
  }
  function showStage(id) {
    document.querySelectorAll('.stage').forEach(v => v.classList.toggle('active', v.id === id));
  }

  async function boot() {
    if (!configured) {
      setConnected('Setup nötig');
      setError('homeError', 'Noch nicht mit Supabase verbunden. Öffne zuerst README.md und trage danach Project URL + Publishable Key in config.js ein.');
      $('createForm').querySelector('button').disabled = true;
      $('joinForm').querySelector('button').disabled = true;
      return;
    }
    try {
      state.client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);
      const { data: sessionData } = await state.client.auth.getSession();
      if (!sessionData.session) {
        const { data, error } = await state.client.auth.signInAnonymously();
        if (error) throw error;
        state.user = data.user;
      } else {
        state.user = sessionData.session.user;
      }
      setConnected('Online', true);
      wireUi();
    } catch (e) {
      setConnected('Verbindung fehlgeschlagen');
      setError('homeError', 'Supabase-Verbindung fehlgeschlagen: ' + friendlyError(e));
    }
  }

  function wireUi() {
    $('createForm').addEventListener('submit', createRoom);
    $('joinForm').addEventListener('submit', joinRoom);
    $('joinCode').addEventListener('input', e => e.target.value = e.target.value.toUpperCase().replace(/[^0-9A-F]/g,'').slice(0,6));
    $('startButton').addEventListener('click', startGame);
    $('restartButton').addEventListener('click', restartGame);
    $('copyCode').addEventListener('click', copyCode);
    $('toggleSecret').addEventListener('click', toggleSecret);
    $('submitLine').addEventListener('click', submitLine);
    $('voteButton').addEventListener('click', castVote);
    $('guessForm').addEventListener('submit', submitGuess);
    wireCanvas();
  }

  async function createRoom(e) {
    e.preventDefault(); setError('homeError');
    const name = $('createName').value.trim();
    if (!name) return;
    try {
      const { data, error } = await state.client.rpc('create_room', { p_name: name });
      if (error) throw error;
      const row = data?.[0];
      if (!row) throw new Error('Raum konnte nicht erstellt werden.');
      await enterRoom(row.room_id);
    } catch (err) { setError('homeError', friendlyError(err)); }
  }

  async function joinRoom(e) {
    e.preventDefault(); setError('homeError');
    const name = $('joinName').value.trim();
    const code = $('joinCode').value.trim().toUpperCase();
    if (!name || code.length !== 6) return setError('homeError','Bitte Name und sechsstelligen Raumcode eingeben.');
    try {
      const { data, error } = await state.client.rpc('join_room', { p_code: code, p_name: name });
      if (error) throw error;
      const row = data?.[0];
      if (!row) throw new Error('Raum konnte nicht betreten werden.');
      await enterRoom(row.room_id);
    } catch (err) { setError('homeError', friendlyError(err)); }
  }

  async function enterRoom(roomId) {
    setError('roomError');
    await loadRoom(roomId);
    await loadPlayers(roomId);
    await loadStrokes(roomId);
    await subscribeRoom(roomId);
    showView('roomView');
    renderAll();
    if (state.room.status !== 'lobby') await loadSecret();
  }

  async function loadRoom(roomId) {
    const { data, error } = await state.client.from('rooms').select('*').eq('id', roomId).single();
    if (error) throw error;
    state.room = data;
  }
  async function loadPlayers(roomId=state.room.id) {
    const { data, error } = await state.client.from('players').select('*').eq('room_id',roomId).order('seat');
    if (error) throw error;
    state.players = data || [];
  }
  async function loadStrokes(roomId=state.room.id) {
    const { data, error } = await state.client.from('strokes').select('*').eq('room_id',roomId).order('created_at');
    if (error) throw error;
    state.strokes = data || [];
    redrawCanvas();
  }
  async function loadSecret() {
    if (!state.room || state.room.status === 'lobby') { state.secret = null; return; }
    try {
      const { data, error } = await state.client.rpc('get_my_secret', { p_room_id: state.room.id });
      if (error) throw error;
      state.secret = data?.[0] || null;
      renderSecret();
      renderGuess();
    } catch (_) {}
  }

  async function subscribeRoom(roomId) {
    if (state.roomChannel) await state.client.removeChannel(state.roomChannel);
    state.roomChannel = state.client.channel(`scribble-room-${roomId}`, { config: { broadcast: { self: false } } })
      .on('postgres_changes',{event:'*',schema:'public',table:'rooms',filter:`id=eq.${roomId}`}, async payload => {
        if (payload.new?.id) state.room = payload.new;
        await syncAfterRoomChange();
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'players',filter:`room_id=eq.${roomId}`}, async () => {
        await loadPlayers(); renderAll();
      })
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'strokes',filter:`room_id=eq.${roomId}`}, payload => {
        if (!state.strokes.some(s=>s.id===payload.new.id)) state.strokes.push(payload.new);
        state.remoteDraft = null; redrawCanvas();
      })
      .on('broadcast',{event:'drawing'}, ({payload}) => {
        if (!payload || payload.user_id === state.user.id) return;
        state.remoteDraft = Array.isArray(payload.points) ? payload.points : null;
        redrawCanvas();
      })
      .on('broadcast',{event:'drawing_end'}, () => { state.remoteDraft = null; redrawCanvas(); })
      .subscribe(status => { if (status === 'SUBSCRIBED') setConnected('Online · Live',true); });
  }

  async function syncAfterRoomChange() {
    state.draftPoints=[]; state.draftReady=false; state.drawing=false; state.remoteDraft=null;
    $('submitLine').disabled = true;
    await loadPlayers();
    if (state.room.status !== 'lobby' && !state.secret) await loadSecret();
    if (state.room.status === 'lobby') { state.secret=null; state.voted=false; state.selectedVote=null; }
    renderAll(); redrawCanvas();
  }

  function me() { return state.players.find(p => p.user_id === state.user.id); }
  function activePlayer() { return state.players.find(p => p.seat === state.room?.turn_index); }
  function isHost() { return state.room?.host_user_id === state.user?.id; }
  function isMyTurn() { return state.room?.status === 'drawing' && activePlayer()?.user_id === state.user?.id; }

  function renderAll() {
    if (!state.room) return;
    $('roomCode').textContent = state.room.code;
    renderPlayers();
    renderStage();
    renderSecret();
  }

  function renderPlayers() {
    const active = activePlayer()?.user_id;
    $('playerList').innerHTML = state.players.map(p => `
      <div class="player ${active===p.user_id && state.room.status==='drawing'?'active':''}">
        <span class="player-name">${escapeHtml(p.name)}</span>
        <span class="player-tags">
          ${p.is_host?'<span class="mini-tag">HOST</span>':''}
          ${p.user_id===state.user.id?'<span class="mini-tag you">DU</span>':''}
        </span>
      </div>`).join('');
    $('startButton').classList.toggle('hidden', !(state.room.status==='lobby' && isHost()));
    $('startButton').disabled = state.players.length < 3;
    $('restartButton').classList.toggle('hidden', !(state.room.status==='result' && isHost()));
    $('hostHint').textContent = state.room.status==='lobby'
      ? (isHost() ? (state.players.length<3?'Mindestens 3 Spieler nötig.':'Bereit zum Starten.') : 'Der Host startet das Spiel.')
      : '';
  }

  function renderStage() {
    const status = state.room.status;
    $('roundChip').textContent = ({lobby:'Lobby',drawing:`Runde ${state.room.round_no}/3`,voting:'Voting',guess:'Letzte Chance',result:'Ergebnis'})[status] || status;
    showStage(({lobby:'lobbyStage',drawing:'drawingStage',voting:'votingStage',guess:'guessStage',result:'resultStage'})[status] || 'lobbyStage');
    if (status==='drawing') renderDrawing();
    if (status==='voting') renderVoting();
    if (status==='guess') renderGuess();
    if (status==='result') renderResult();
  }

  function renderSecret() {
    if (!state.secret || state.room.status==='lobby') return;
    const main = $('secretMain'), sub=$('secretSub');
    if (!state.secretVisible) {
      main.textContent='••••••••'; main.className='secret-main'; sub.textContent='Deine Info ist verborgen.'; $('toggleSecret').textContent='Anzeigen'; return;
    }
    $('toggleSecret').textContent='Verbergen';
    if (state.secret.is_imposter) {
      main.textContent='Du bist der Imposter 😈'; main.className='secret-main imposter'; sub.textContent=`Du kennst nur die Kategorie: ${state.secret.category}`;
    } else {
      main.textContent=`Wort: ${state.secret.word}`; main.className='secret-main normal'; sub.textContent=`Kategorie: ${state.secret.category}`;
    }
  }

  function renderDrawing() {
    const active = activePlayer();
    $('roundLabel').textContent=`Runde ${state.room.round_no} / 3`;
    $('turnLabel').textContent=active ? `${active.name} zeichnet` : 'Zug wird geladen…';
    $('categoryLabel').textContent=state.room.category || state.secret?.category || 'Kategorie';
    const mine=isMyTurn();
    $('canvasLock').classList.toggle('hidden', mine);
    $('lockTitle').textContent = active ? `${active.name} ist dran` : 'Warte kurz';
    $('lockSub').textContent = 'Du kannst die Zeichnung live verfolgen.';
    $('drawHint').textContent = mine ? (state.draftReady?'Linie fertig – jetzt abschicken.':'Du bist dran: genau eine durchgehende Linie.') : 'Warte auf deinen Zug.';
    $('submitLine').disabled = !(mine && state.draftReady);
  }

  function renderVoting() {
    $('voteGrid').innerHTML = state.players.map(p => `<button type="button" class="vote-card ${state.selectedVote===p.user_id?'selected':''}" data-user="${p.user_id}" ${p.user_id===state.user.id || state.voted?'disabled':''}>${escapeHtml(p.name)}</button>`).join('');
    document.querySelectorAll('.vote-card:not(:disabled)').forEach(btn=>btn.addEventListener('click',()=>{
      state.selectedVote=btn.dataset.user; renderVoting(); $('voteButton').disabled=false;
    }));
    $('voteButton').disabled = state.voted || !state.selectedVote;
    $('voteButton').textContent = state.voted ? 'Stimme abgegeben ✓' : 'Stimme abgeben';
    $('voteStatus').textContent = state.voted ? 'Warte auf die Stimmen der anderen Spieler …' : 'Deine Wahl bleibt bis zur Auswertung geheim.';
  }

  function renderGuess() {
    if (!state.secret) return;
    $('guessInfo').textContent = state.room?.result_text || 'Der Imposter hat noch eine letzte Chance.';
    const imp=!!state.secret.is_imposter;
    $('guessForm').classList.toggle('hidden',!imp);
    $('guessWaiting').classList.toggle('hidden',imp);
  }

  function renderResult() {
    const impWin=state.room.winner==='imposter';
    $('resultIcon').textContent=impWin?'😈':'🎨';
    $('resultTitle').textContent=impWin?'Imposter gewinnt':'Zeichner gewinnen';
    $('resultText').textContent=state.room.result_text || 'Spiel beendet.';
  }

  async function startGame() {
    setError('roomError');
    try { const {error}=await state.client.rpc('start_game',{p_room_id:state.room.id}); if(error) throw error; await loadRoom(state.room.id); await loadSecret(); renderAll(); }
    catch(e){setError('roomError',friendlyError(e));}
  }
  async function restartGame() {
    setError('roomError');
    try { const {error}=await state.client.rpc('restart_game',{p_room_id:state.room.id}); if(error) throw error; await loadRoom(state.room.id); await loadStrokes(); await syncAfterRoomChange(); }
    catch(e){setError('roomError',friendlyError(e));}
  }
  async function castVote() {
    if (!state.selectedVote || state.voted) return;
    setError('roomError');
    try { const {error}=await state.client.rpc('cast_vote',{p_room_id:state.room.id,p_target_user_id:state.selectedVote}); if(error) throw error; state.voted=true; renderVoting(); }
    catch(e){setError('roomError',friendlyError(e));}
  }
  async function submitGuess(e) {
    e.preventDefault(); const guess=$('guessInput').value.trim(); if(!guess)return;
    try { const {error}=await state.client.rpc('submit_guess',{p_room_id:state.room.id,p_guess:guess}); if(error) throw error; }
    catch(err){setError('roomError',friendlyError(err));}
  }

  async function copyCode() {
    try { await navigator.clipboard.writeText(state.room.code); $('copyCode').textContent='Kopiert ✓'; setTimeout(()=>$('copyCode').textContent='Code kopieren',1200); }
    catch (_) { $('copyCode').textContent=state.room.code; }
  }
  function toggleSecret(){state.secretVisible=!state.secretVisible;renderSecret();}

  function wireCanvas() {
    const c=$('canvas');
    const pos=e=>{const r=c.getBoundingClientRect();return {x:Math.max(0,Math.min(c.width,(e.clientX-r.left)*c.width/r.width)),y:Math.max(0,Math.min(c.height,(e.clientY-r.top)*c.height/r.height))};};
    c.addEventListener('pointerdown',e=>{
      if(!isMyTurn()||state.draftReady)return;
      c.setPointerCapture?.(e.pointerId); state.drawing=true; state.draftPoints=[pos(e)]; redrawCanvas();
    });
    c.addEventListener('pointermove',e=>{
      if(!state.drawing)return; state.draftPoints.push(pos(e)); redrawCanvas(); broadcastDraft();
    });
    const finish=e=>{
      if(!state.drawing)return; state.drawing=false;
      if(state.draftPoints.length===1){const p=state.draftPoints[0];state.draftPoints.push({x:p.x+1,y:p.y+1});}
      state.draftReady=true; $('submitLine').disabled=false; renderDrawing(); broadcastDraft(true);
      try{c.releasePointerCapture?.(e.pointerId);}catch(_){}
    };
    c.addEventListener('pointerup',finish); c.addEventListener('pointercancel',finish);
  }

  async function broadcastDraft(force=false) {
    if(!state.roomChannel || !state.draftPoints.length)return;
    const now=performance.now(); if(!force && now-state.lastBroadcast<45)return; state.lastBroadcast=now;
    try { await state.roomChannel.send({type:'broadcast',event:'drawing',payload:{user_id:state.user.id,points:state.draftPoints}}); } catch(_){}
  }

  async function submitLine() {
    if(!isMyTurn()||!state.draftReady)return;
    $('submitLine').disabled=true; setError('roomError');
    try {
      const points=state.draftPoints.map(p=>({x:Math.round(p.x*10)/10,y:Math.round(p.y*10)/10}));
      const {error}=await state.client.rpc('submit_stroke',{p_room_id:state.room.id,p_points:points});
      if(error)throw error;
      await state.roomChannel?.send({type:'broadcast',event:'drawing_end',payload:{user_id:state.user.id}});
      state.draftPoints=[];state.draftReady=false;state.drawing=false;
    } catch(e){$('submitLine').disabled=false;setError('roomError',friendlyError(e));}
  }

  function redrawCanvas() {
    const c=$('canvas'),ctx=c.getContext('2d'); if(!ctx)return;
    ctx.clearRect(0,0,c.width,c.height);ctx.lineWidth=6;ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#111827';
    const draw=points=>{if(!Array.isArray(points)||points.length<2)return;ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(Number(p.x),Number(p.y)):ctx.moveTo(Number(p.x),Number(p.y)));ctx.stroke();};
    state.strokes.forEach(s=>draw(s.points)); if(state.remoteDraft)draw(state.remoteDraft); if(state.draftPoints.length)draw(state.draftPoints);
  }

  function escapeHtml(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}

  boot();
})();
