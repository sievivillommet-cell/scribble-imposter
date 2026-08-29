-- Scribble Imposter – Supabase setup
-- Kompletten Inhalt einmal im Supabase SQL Editor ausführen.

create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_user_id uuid not null,
  status text not null default 'lobby' check (status in ('lobby','drawing','voting','guess','result')),
  category text,
  round_no integer not null default 1,
  turn_index integer not null default 0,
  winner text check (winner in ('players','imposter') or winner is null),
  result_text text,
  created_at timestamptz not null default now()
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null,
  name text not null,
  is_host boolean not null default false,
  seat integer not null,
  joined_at timestamptz not null default now(),
  unique(room_id, user_id),
  unique(room_id, seat)
);

create table if not exists public.room_secrets (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  word text not null,
  imposter_user_id uuid not null
);

create table if not exists public.strokes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  round_no integer not null,
  turn_index integer not null,
  player_user_id uuid not null,
  points jsonb not null,
  created_at timestamptz not null default now(),
  unique(room_id, round_no, turn_index)
);

create table if not exists public.votes (
  room_id uuid not null references public.rooms(id) on delete cascade,
  voter_user_id uuid not null,
  target_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(room_id, voter_user_id)
);

alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.room_secrets enable row level security;
alter table public.strokes enable row level security;
alter table public.votes enable row level security;

-- RLS-Helfer: SECURITY DEFINER vermeidet rekursive Policies auf players.
create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.players p
    where p.room_id = p_room_id and p.user_id = auth.uid()
  );
$$;

revoke all on function public.is_room_member(uuid) from public, anon;
grant execute on function public.is_room_member(uuid) to authenticated;

-- Nur Mitglieder eines Raumes dürfen dessen öffentliche Zustände lesen.
drop policy if exists "members read rooms" on public.rooms;
create policy "members read rooms" on public.rooms for select to authenticated
using (public.is_room_member(id));

drop policy if exists "members read players" on public.players;
create policy "members read players" on public.players for select to authenticated
using (public.is_room_member(room_id));

drop policy if exists "members read strokes" on public.strokes;
create policy "members read strokes" on public.strokes for select to authenticated
using (public.is_room_member(room_id));

-- Keine direkte Browser-Leseberechtigung auf room_secrets oder votes.
-- Änderungen laufen ausschließlich über SECURITY DEFINER Funktionen.

grant select on public.rooms, public.players, public.strokes to authenticated;
revoke all on public.room_secrets, public.votes from anon, authenticated;
revoke insert, update, delete on public.rooms, public.players, public.strokes from anon, authenticated;

create or replace function public.make_room_code()
returns text
language plpgsql
as $$
declare
  v_code text;
begin
  loop
    v_code := upper(substr(encode(gen_random_bytes(5), 'hex'), 1, 6));
    exit when not exists(select 1 from public.rooms where code = v_code);
  end loop;
  return v_code;
end;
$$;

create or replace function public.create_room(p_name text)
returns table(room_id uuid, room_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room uuid;
  v_code text;
  v_name text;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  v_name := left(trim(p_name), 24);
  if length(v_name) < 1 then raise exception 'Bitte einen Namen eingeben'; end if;

  v_code := public.make_room_code();
  insert into public.rooms(code, host_user_id) values (v_code, auth.uid()) returning id into v_room;
  insert into public.players(room_id, user_id, name, is_host, seat)
    values (v_room, auth.uid(), v_name, true, 0);
  return query select v_room, v_code;
end;
$$;

create or replace function public.join_room(p_code text, p_name text)
returns table(room_id uuid, room_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms%rowtype;
  v_name text;
  v_seat integer;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  v_name := left(trim(p_name), 24);
  if length(v_name) < 1 then raise exception 'Bitte einen Namen eingeben'; end if;

  select * into v_room from public.rooms where code = upper(trim(p_code));
  if v_room.id is null then raise exception 'Raum nicht gefunden'; end if;
  if v_room.status <> 'lobby' then raise exception 'Dieses Spiel läuft bereits'; end if;

  if exists(select 1 from public.players where room_id=v_room.id and lower(name)=lower(v_name) and user_id<>auth.uid()) then
    raise exception 'Dieser Name ist bereits vergeben';
  end if;

  if exists(select 1 from public.players where room_id=v_room.id and user_id=auth.uid()) then
    update public.players set name=v_name where room_id=v_room.id and user_id=auth.uid();
  else
    select coalesce(max(seat), -1) + 1 into v_seat from public.players where room_id=v_room.id;
    insert into public.players(room_id,user_id,name,is_host,seat)
      values(v_room.id,auth.uid(),v_name,false,v_seat);
  end if;

  return query select v_room.id, v_room.code;
end;
$$;

create or replace function public.start_game(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_category text;
  v_word text;
  v_imposter uuid;
  v_categories text[] := array['Fahrzeuge','Tiere','Essen','Gegenstände','Orte','Berufe','Sport'];
  v_words text[];
begin
  if not exists(select 1 from public.rooms where id=p_room_id and host_user_id=auth.uid()) then
    raise exception 'Nur der Host kann starten';
  end if;
  select count(*) into v_count from public.players where room_id=p_room_id;
  if v_count < 3 then raise exception 'Mindestens 3 Spieler nötig'; end if;

  v_category := v_categories[1 + floor(random()*array_length(v_categories,1))::int];
  case v_category
    when 'Fahrzeuge' then v_words := array['Wohnmobil','Traktor','Feuerwehrauto','Motorrad','Gabelstapler','Bagger','Limousine','Helikopter','U-Boot','Segelboot','Formel-1-Auto','Skilift'];
    when 'Tiere' then v_words := array['Giraffe','Pinguin','Krokodil','Qualle','Elefant','Känguru','Oktopus','Eule','Hai','Waschbär','Panda','Chamäleon'];
    when 'Essen' then v_words := array['Pizza','Hamburger','Sushi','Spaghetti','Croissant','Taco','Donut','Fondue','Hotdog','Wassermelone','Lasagne','Popcorn'];
    when 'Gegenstände' then v_words := array['Regenschirm','Zahnbürste','Staubsauger','Kopfhörer','Schlüssel','Toaster','Rucksack','Schere','Taschenlampe','Wecker','Koffer','Fernbedienung'];
    when 'Orte' then v_words := array['Flughafen','Schule','Schwimmbad','Kino','Bauernhof','Bahnhof','Burg','Campingplatz','Krankenhaus','Supermarkt','Skipiste','Vergnügungspark'];
    when 'Berufe' then v_words := array['Feuerwehrmann','Pilot','Koch','Zahnarzt','Astronaut','Bäcker','Polizist','Gärtner','Fotograf','Bauarbeiter','Lehrer','Mechaniker'];
    else v_words := array['Fussball','Skifahren','Unihockey','Tennis','Boxen','Basketball','Surfen','Klettern','Eishockey','Golf','Volleyball','Bogenschießen'];
  end case;
  v_word := v_words[1 + floor(random()*array_length(v_words,1))::int];
  select user_id into v_imposter from public.players where room_id=p_room_id order by random() limit 1;

  insert into public.room_secrets(room_id,word,imposter_user_id)
  values(p_room_id,v_word,v_imposter)
  on conflict(room_id) do update set word=excluded.word, imposter_user_id=excluded.imposter_user_id;

  delete from public.strokes where room_id=p_room_id;
  delete from public.votes where room_id=p_room_id;
  update public.rooms set status='drawing', category=v_category, round_no=1, turn_index=0,
    winner=null, result_text=null where id=p_room_id;
end;
$$;

create or replace function public.get_my_secret(p_room_id uuid)
returns table(category text, is_imposter boolean, word text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret public.room_secrets%rowtype;
  v_category text;
begin
  if not exists(select 1 from public.players where room_id=p_room_id and user_id=auth.uid()) then
    raise exception 'Du bist nicht in diesem Raum';
  end if;
  select * into v_secret from public.room_secrets where room_id=p_room_id;
  select r.category into v_category from public.rooms r where r.id=p_room_id;
  if v_secret.room_id is null then raise exception 'Spiel wurde noch nicht gestartet'; end if;
  return query select v_category, (v_secret.imposter_user_id=auth.uid()),
    case when v_secret.imposter_user_id=auth.uid() then null::text else v_secret.word end;
end;
$$;

create or replace function public.submit_stroke(p_room_id uuid, p_points jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms%rowtype;
  v_player public.players%rowtype;
  v_count integer;
begin
  select * into v_room from public.rooms where id=p_room_id for update;
  if v_room.status <> 'drawing' then raise exception 'Es wird gerade nicht gezeichnet'; end if;
  select * into v_player from public.players where room_id=p_room_id and user_id=auth.uid();
  if v_player.id is null or v_player.seat <> v_room.turn_index then raise exception 'Du bist nicht dran'; end if;
  if jsonb_typeof(p_points) <> 'array' or jsonb_array_length(p_points) < 2 then raise exception 'Ungültige Linie'; end if;

  insert into public.strokes(room_id,round_no,turn_index,player_user_id,points)
  values(p_room_id,v_room.round_no,v_room.turn_index,auth.uid(),p_points);

  select count(*) into v_count from public.players where room_id=p_room_id;
  if v_room.round_no >= 3 and v_room.turn_index >= v_count-1 then
    update public.rooms set status='voting' where id=p_room_id;
  elsif v_room.turn_index >= v_count-1 then
    update public.rooms set round_no=v_room.round_no+1, turn_index=0 where id=p_room_id;
  else
    update public.rooms set turn_index=v_room.turn_index+1 where id=p_room_id;
  end if;
end;
$$;

create or replace function public.cast_vote(p_room_id uuid, p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_votes integer;
  v_top_target uuid;
  v_top_count integer;
  v_tied boolean;
  v_imposter uuid;
  v_imposter_name text;
begin
  if not exists(select 1 from public.rooms where id=p_room_id and status='voting') then raise exception 'Abstimmung ist nicht aktiv'; end if;
  if not exists(select 1 from public.players where room_id=p_room_id and user_id=auth.uid()) then raise exception 'Nicht im Raum'; end if;
  if not exists(select 1 from public.players where room_id=p_room_id and user_id=p_target_user_id) then raise exception 'Ungültige Wahl'; end if;
  if p_target_user_id=auth.uid() then raise exception 'Du kannst nicht für dich selbst stimmen'; end if;

  insert into public.votes(room_id,voter_user_id,target_user_id)
  values(p_room_id,auth.uid(),p_target_user_id)
  on conflict(room_id,voter_user_id) do update set target_user_id=excluded.target_user_id, created_at=now();

  select count(*) into v_total from public.players where room_id=p_room_id;
  select count(*) into v_votes from public.votes where room_id=p_room_id;
  if v_votes < v_total then return; end if;

  select target_user_id, count(*)::int into v_top_target, v_top_count
  from public.votes where room_id=p_room_id
  group by target_user_id order by count(*) desc, target_user_id limit 1;

  select count(*) > 1 into v_tied from (
    select target_user_id from public.votes where room_id=p_room_id
    group by target_user_id having count(*) = v_top_count
  ) t;

  select imposter_user_id into v_imposter from public.room_secrets where room_id=p_room_id;
  select name into v_imposter_name from public.players where room_id=p_room_id and user_id=v_imposter;

  if v_tied then
    update public.rooms set status='result',winner='imposter',result_text='Unentschieden bei der Abstimmung – der Imposter '||v_imposter_name||' entkommt!' where id=p_room_id;
  elsif v_top_target=v_imposter then
    update public.rooms set status='guess',result_text=v_imposter_name||' wurde entlarvt. Der Imposter darf jetzt das Wort raten.' where id=p_room_id;
  else
    update public.rooms set status='result',winner='imposter',result_text='Falsche Person gewählt – '||v_imposter_name||' war der Imposter und gewinnt!' where id=p_room_id;
  end if;
end;
$$;

create or replace function public.submit_guess(p_room_id uuid, p_guess text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret public.room_secrets%rowtype;
  v_name text;
  v_guess text;
begin
  if not exists(select 1 from public.rooms where id=p_room_id and status='guess') then raise exception 'Es wird gerade nicht geraten'; end if;
  select * into v_secret from public.room_secrets where room_id=p_room_id;
  if v_secret.imposter_user_id <> auth.uid() then raise exception 'Nur der Imposter darf raten'; end if;
  select name into v_name from public.players where room_id=p_room_id and user_id=auth.uid();
  v_guess := lower(trim(coalesce(p_guess,'')));

  if v_guess = lower(trim(v_secret.word)) then
    update public.rooms set status='result',winner='imposter',result_text=v_name||' wurde entlarvt, hat aber „'||v_secret.word||'“ richtig erraten. Der Imposter gewinnt!' where id=p_room_id;
  else
    update public.rooms set status='result',winner='players',result_text=v_name||' wurde entlarvt und lag daneben. Das Wort war „'||v_secret.word||'“. Die Zeichner gewinnen!' where id=p_room_id;
  end if;
end;
$$;

create or replace function public.restart_game(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists(select 1 from public.rooms where id=p_room_id and host_user_id=auth.uid()) then raise exception 'Nur der Host kann neu starten'; end if;
  delete from public.strokes where room_id=p_room_id;
  delete from public.votes where room_id=p_room_id;
  delete from public.room_secrets where room_id=p_room_id;
  update public.rooms set status='lobby',category=null,round_no=1,turn_index=0,winner=null,result_text=null where id=p_room_id;
end;
$$;

revoke all on function public.make_room_code() from public, anon, authenticated;
revoke all on function public.create_room(text) from public, anon;
revoke all on function public.join_room(text,text) from public, anon;
revoke all on function public.start_game(uuid) from public, anon;
revoke all on function public.get_my_secret(uuid) from public, anon;
revoke all on function public.submit_stroke(uuid,jsonb) from public, anon;
revoke all on function public.cast_vote(uuid,uuid) from public, anon;
revoke all on function public.submit_guess(uuid,text) from public, anon;
revoke all on function public.restart_game(uuid) from public, anon;
grant execute on function public.create_room(text) to authenticated;
grant execute on function public.join_room(text,text) to authenticated;
grant execute on function public.start_game(uuid) to authenticated;
grant execute on function public.get_my_secret(uuid) to authenticated;
grant execute on function public.submit_stroke(uuid,jsonb) to authenticated;
grant execute on function public.cast_vote(uuid,uuid) to authenticated;
grant execute on function public.submit_guess(uuid,text) to authenticated;
grant execute on function public.restart_game(uuid) to authenticated;

-- Realtime für öffentliche Spielzustände aktivieren (idempotent).
do $$
begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='rooms') then
    alter publication supabase_realtime add table public.rooms;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='players') then
    alter publication supabase_realtime add table public.players;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='strokes') then
    alter publication supabase_realtime add table public.strokes;
  end if;
end $$;
