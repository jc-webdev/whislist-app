create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null,
  avatar_url text,
  city text default 'Warszawa',
  birthday text,
  has_onboarded boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists has_onboarded boolean not null default false;

-- Rezerwacje włącza/wyłącza się per grupa (patrz idea_groups), nie globalnie
-- dla całego konta — ta kolumna była pierwszą, uproszczoną wersją tego ustawienia.
-- Najpierw trzeba zdjąć starą politykę, która na niej jeszcze polega (z
-- poprzedniej wersji tego skryptu), inaczej DROP COLUMN się wywali.
drop policy if exists "gift_reservations_insert_not_owner" on public.gift_reservations;
alter table public.profiles drop column if exists reservations_enabled;

-- Ta sama nazwa kolumny wraca, ale z inną rolą: to teraz GŁÓWNY przełącznik
-- ("wyłącz wszystkie rezerwacje naraz"), nadrzędny wobec ustawień per grupa,
-- a nie jedyny mechanizm jak poprzednio. Potrzebny szczególnie dla pomysłów
-- "Wszyscy znajomi" (visible_to_all), które nie mają żadnej grupy do
-- przełączenia. Domyślnie true, więc nic się nie zmienia dla istniejących kont.
alter table public.profiles add column if not exists reservations_enabled boolean not null default true;

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, friend_id),
  check (user_id <> friend_id)
);

-- Zaproszenie do znajomych czeka tu, dopóki odbiorca go nie zaakceptuje
-- (wtedy wstawiamy wiersz do friendships i kasujemy to zaproszenie) albo nie
-- odrzuci (wtedy po prostu kasujemy wiersz) — tabela trzyma więc wyłącznie
-- zaproszenia oczekujące, bez osobnej kolumny status.
create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (sender_id, recipient_id),
  check (sender_id <> recipient_id)
);

create table if not exists public.idea_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  description text,
  reservations_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.idea_groups add column if not exists reservations_enabled boolean not null default true;

create table if not exists public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.idea_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (group_id, user_id)
);

create table if not exists public.gift_ideas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text,
  -- Kategoria produktu (sekcja 20/21 instrukcji) dopiero czeka na osobną
  -- tabelę Product — na razie nullable, żeby formularz dodawania pomysłu
  -- (który jej jeszcze nie zbiera) mógł w ogóle zapisywać rekordy.
  category text check (category is null or category in (
    'elektronika',
    'dom',
    'podroz',
    'moda',
    'sport',
    'książki',
    'jedzenie',
    'doświadczenie'
  )),
  url text,
  store text,
  price numeric(10,2),
  image_url text,
  priority text not null check (priority in ('bardzo', 'chce', 'moze')),
  favorite boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.gift_ideas alter column category drop not null;
alter table public.gift_ideas add column if not exists url text;
alter table public.gift_ideas drop column if exists reserved_by;
-- Widoczność żyje teraz w idea_visibility (przypisanie do realnych grup),
-- nie jako sztywna lista tagów na samym pomyśle.
alter table public.gift_ideas drop column if exists visibility;

-- Komu pomysł jest udostępniony: brak wierszy = widoczny tylko dla właściciela.
create table if not exists public.idea_visibility (
  idea_id uuid not null references public.gift_ideas(id) on delete cascade,
  group_id uuid not null references public.idea_groups(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (idea_id, group_id)
);

-- Rezerwacja żyje w osobnej tabeli, żeby RLS mogło całkowicie odciąć
-- właściciela pomysłu od odczytu tych wierszy (patrz polityki niżej).
create table if not exists public.gift_reservations (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null unique references public.gift_ideas(id) on delete cascade,
  reserved_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Cykl życia pomysłu: aktywny → zarchiwizowany (po "Dostałem ❤️"). Domyślnie
-- "active", więc istniejące pomysły nie zmieniają zachowania.
alter table public.gift_ideas add column if not exists status text not null default 'active';
alter table public.gift_ideas add column if not exists archived_at timestamptz;

-- Trzecia kategoria widoczności obok "tylko ja" (brak wierszy w
-- idea_visibility) i "wybrane grupy": widoczne dla każdego znajomego,
-- niezależnie od grup. Domyślnie false, więc istniejące pomysły się nie zmieniają.
alter table public.gift_ideas add column if not exists visible_to_all boolean not null default false;

do $$
begin
  alter table public.gift_ideas add constraint gift_ideas_status_check check (status in ('active', 'archived'));
exception
  when duplicate_object then null;
end $$;

-- Cykl życia rezerwacji: reserved → purchased → completed, albo cancelled
-- w dowolnym momencie. Istniejące wiersze dostają domyślnie "reserved", czyli
-- dokładnie stan, w jakim faktycznie były przed tą migracją.
alter table public.gift_reservations add column if not exists status text not null default 'reserved';

do $$
begin
  alter table public.gift_reservations add constraint gift_reservations_status_check
    check (status in ('reserved', 'purchased', 'cancelled', 'completed'));
exception
  when duplicate_object then null;
end $$;

-- Oryginalny "unique(idea_id)" blokował na zawsze ponowną rezerwację po
-- anulowaniu (jeden wiersz zajmował unikalność idea_id na stałe). Zamieniamy
-- to na częściowy unique index: tylko jedna AKTYWNA (reserved/purchased)
-- rezerwacja na pomysł naraz, ale anulowane/zakończone wiersze zostają w
-- historii i nie blokują kolejnej rezerwacji.
alter table public.gift_reservations drop constraint if exists gift_reservations_idea_id_key;
create unique index if not exists idx_gift_reservations_active_idea
  on public.gift_reservations (idea_id)
  where status in ('reserved', 'purchased');

-- Powiadomienia: wyłącznie funkcje SECURITY DEFINER mogą tu wstawiać wiersze
-- (patrz mark_idea_received niżej) — klient nigdy nie ma prawa insert, więc
-- nie da się sfałszować powiadomienia ani podejrzeć powiadomienia kogoś innego.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('gift_received_reserved', 'gift_received_purchased_confirmed')),
  idea_id uuid references public.gift_ideas(id) on delete set null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

-- related_user_id niesie "kto" dla powiadomień o znajomych (np. kto wysłał
-- zaproszenie) — idea_id nie ma tu zastosowania.
alter table public.notifications add column if not exists related_user_id uuid references public.profiles(id) on delete set null;

-- Pełna, docelowa lista dozwolonych typów jest zdefiniowana raz, na dole
-- pliku (patrz ostatnie "alter table ... add constraint
-- notifications_type_check") — była tu wcześniej osobna, węższa definicja,
-- która na żywej bazie z realnymi wierszami nowszych typów (poll_created,
-- gift_plan_invite, ...) powodowała błąd "check constraint is violated by
-- some row" przy każdym ponownym wklejeniu całego pliku od góry.

create index if not exists idx_profiles_email on public.profiles(email);
create index if not exists idx_friendships_user_id on public.friendships(user_id);
create index if not exists idx_friendships_friend_id on public.friendships(friend_id);
create index if not exists idx_friend_requests_sender_id on public.friend_requests(sender_id);
create index if not exists idx_friend_requests_recipient_id on public.friend_requests(recipient_id);
create index if not exists idx_gift_ideas_user_id on public.gift_ideas(user_id);
create index if not exists idx_group_members_group_id on public.group_members(group_id);
create index if not exists idx_gift_reservations_reserved_by on public.gift_reservations(reserved_by);
create index if not exists idx_gift_reservations_reserved_by_status on public.gift_reservations(reserved_by, status);
create index if not exists idx_idea_visibility_group_id on public.idea_visibility(group_id);
create index if not exists idx_gift_ideas_user_id_status on public.gift_ideas(user_id, status);
create index if not exists idx_notifications_recipient_id on public.notifications(recipient_id, created_at desc);

-- Realtime dla dzwoneczka powiadomień i zakładki Zaproszenia — bez tego
-- klient musiałby odpytywać bazę w pętli, żeby zauważyć nowe wiersze.
-- RLS nadal obowiązuje na kanałach Realtime, więc klient i tak dostanie
-- tylko zdarzenia dotyczące własnych wierszy.
do $$
begin
  alter publication supabase_realtime add table public.notifications;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.friend_requests;
exception
  when duplicate_object then null;
end $$;

alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.friend_requests enable row level security;
alter table public.idea_groups enable row level security;
alter table public.group_members enable row level security;
alter table public.gift_ideas enable row level security;
alter table public.idea_visibility enable row level security;
alter table public.gift_reservations enable row level security;
alter table public.notifications enable row level security;

drop policy if exists "profiles_select_all_for_authenticated" on public.profiles;
create policy "profiles_select_all_for_authenticated"
  on public.profiles for select
  using (auth.uid() is not null);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "friendships_select_own_and_related" on public.friendships;
create policy "friendships_select_own_and_related"
  on public.friendships for select
  using (
    auth.uid() = user_id
    or auth.uid() = friend_id
    or auth.uid() is not null
  );

drop policy if exists "friendships_modify_own" on public.friendships;
create policy "friendships_modify_own"
  on public.friendships for insert
  with check (auth.uid() = user_id);

drop policy if exists "friend_requests_select_related" on public.friend_requests;
create policy "friend_requests_select_related"
  on public.friend_requests for select
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

drop policy if exists "friend_requests_insert_own" on public.friend_requests;
create policy "friend_requests_insert_own"
  on public.friend_requests for insert
  with check (auth.uid() = sender_id);

-- Kasowanie pokrywa trzy przypadki: nadawca cofa wysłane zaproszenie,
-- odbiorca je odrzuca, albo odbiorca je akceptuje (kasuje po wstawieniu
-- wiersza do friendships) — we wszystkich trzech usuwa je jedna ze stron.
drop policy if exists "friend_requests_delete_related" on public.friend_requests;
create policy "friend_requests_delete_related"
  on public.friend_requests for delete
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

-- Powiadamia odbiorcę od razu przy wysłaniu zaproszenia — SECURITY DEFINER,
-- bo klient nie ma (i nie powinien mieć) prawa insert na notifications.
create or replace function public.notify_friend_request_received()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into notifications (recipient_id, type, related_user_id)
  values (new.recipient_id, 'friend_request_received', new.sender_id);
  return new;
end;
$$;

drop trigger if exists trg_notify_friend_request_received on public.friend_requests;
create trigger trg_notify_friend_request_received
  after insert on public.friend_requests
  for each row execute function public.notify_friend_request_received();

-- Jedyna droga zaakceptowania zaproszenia: wstawia friendships, kasuje
-- zaproszenie i powiadamia nadawcę — atomowo, w jednej funkcji, zamiast
-- dwóch osobnych zapytań z klienta.
create or replace function public.accept_friend_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender_id uuid;
  v_recipient_id uuid;
begin
  select sender_id, recipient_id into v_sender_id, v_recipient_id
  from friend_requests where id = p_request_id;

  if v_recipient_id is null then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if v_recipient_id <> auth.uid() then
    raise exception 'NOT_REQUEST_RECIPIENT';
  end if;

  insert into friendships (user_id, friend_id) values (auth.uid(), v_sender_id);
  delete from friend_requests where id = p_request_id;
  insert into notifications (recipient_id, type, related_user_id)
  values (v_sender_id, 'friend_request_accepted', auth.uid());
end;
$$;

revoke all on function public.accept_friend_request(uuid) from public;
grant execute on function public.accept_friend_request(uuid) to authenticated;

drop policy if exists "idea_groups_select_all_for_authenticated" on public.idea_groups;
create policy "idea_groups_select_all_for_authenticated"
  on public.idea_groups for select
  using (auth.uid() is not null);

drop policy if exists "idea_groups_modify_own" on public.idea_groups;
create policy "idea_groups_modify_own"
  on public.idea_groups for insert
  with check (auth.uid() = owner_id);

drop policy if exists "idea_groups_update_own" on public.idea_groups;
create policy "idea_groups_update_own"
  on public.idea_groups for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "group_members_select_all_for_authenticated" on public.group_members;
create policy "group_members_select_all_for_authenticated"
  on public.group_members for select
  using (auth.uid() is not null);

drop policy if exists "group_members_modify_own_group" on public.group_members;
create policy "group_members_modify_own_group"
  on public.group_members for insert
  with check (
    exists (
      select 1
      from public.idea_groups g
      where g.id = group_id
        and g.owner_id = auth.uid()
    )
  );

-- gift_ideas i idea_visibility sprawdzają się nawzajem (widoczność pomysłu
-- zależy od tego, czy jestem właścicielem pomysłu; polityka idea_visibility
-- z kolei sprawdza właściciela pomysłu w gift_ideas) — zwykłe "exists" po obu
-- stronach wywołuje nieskończoną rekurencję RLS ("infinite recursion detected
-- in policy"). SECURITY DEFINER function omija RLS przy sprawdzaniu warunku,
-- przerywając cykl (ten sam wzorzec co is_idea_reserved poniżej).
create or replace function public.idea_shared_with_me(p_idea_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from idea_visibility iv
    join group_members gm on gm.group_id = iv.group_id
    where iv.idea_id = p_idea_id
      and gm.user_id = auth.uid()
  );
$$;

-- Znajomość jako warunek widoczności dla kategorii "Wszyscy znajomi"
-- (visible_to_all) — SECURITY DEFINER z tego samego powodu co powyżej.
create or replace function public.is_friend_of(p_owner_id uuid, p_viewer_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from friendships f
    where (f.user_id = p_owner_id and f.friend_id = p_viewer_id)
       or (f.user_id = p_viewer_id and f.friend_id = p_owner_id)
  );
$$;

-- Wcześniej każdy zalogowany widział KAŻDY pomysł, niezależnie od udostępnienia
-- go jakiejkolwiek grupie — poniższa polityka to naprawia: widzisz tylko swoje
-- własne pomysły, cudze które trafiły do grupy, do której należysz, oraz
-- cudze oznaczone jako widoczne dla wszystkich znajomych (jeśli jesteś znajomym).
drop policy if exists "gift_ideas_select_all_for_authenticated" on public.gift_ideas;
drop policy if exists "gift_ideas_select_owned_or_shared" on public.gift_ideas;
create policy "gift_ideas_select_owned_or_shared"
  on public.gift_ideas for select
  using (
    auth.uid() = user_id
    or public.idea_shared_with_me(gift_ideas.id)
    or (gift_ideas.visible_to_all and public.is_friend_of(gift_ideas.user_id, auth.uid()))
  );

drop policy if exists "gift_ideas_insert_own" on public.gift_ideas;
create policy "gift_ideas_insert_own"
  on public.gift_ideas for insert
  with check (auth.uid() = user_id);

drop policy if exists "gift_ideas_update_own" on public.gift_ideas;
create policy "gift_ideas_update_own"
  on public.gift_ideas for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "gift_ideas_delete_own" on public.gift_ideas;
create policy "gift_ideas_delete_own"
  on public.gift_ideas for delete
  using (auth.uid() = user_id);

-- SECURITY DEFINER — patrz komentarz nad idea_shared_with_me powyżej: to samo
-- omijanie RLS, tym razem po stronie idea_visibility, żeby jej polityki nie
-- wywoływały z powrotem polityk gift_ideas.
create or replace function public.owns_idea(p_idea_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from gift_ideas i where i.id = p_idea_id and i.user_id = auth.uid());
$$;

drop policy if exists "idea_visibility_select_related" on public.idea_visibility;
create policy "idea_visibility_select_related"
  on public.idea_visibility for select
  using (
    public.owns_idea(idea_id)
    or exists (select 1 from public.group_members gm where gm.group_id = idea_visibility.group_id and gm.user_id = auth.uid())
  );

drop policy if exists "idea_visibility_insert_own_idea" on public.idea_visibility;
create policy "idea_visibility_insert_own_idea"
  on public.idea_visibility for insert
  with check (
    public.owns_idea(idea_id)
    and exists (
      select 1 from public.idea_groups g
      where g.id = group_id
        and (
          g.owner_id = auth.uid()
          or exists (select 1 from public.group_members gm where gm.group_id = g.id and gm.user_id = auth.uid())
        )
    )
  );

drop policy if exists "idea_visibility_delete_own_idea" on public.idea_visibility;
create policy "idea_visibility_delete_own_idea"
  on public.idea_visibility for delete
  using (
    public.owns_idea(idea_id)
  );

-- Rezerwacje: nikt oprócz osoby, która zarezerwowała, nie widzi wiersza
-- bezpośrednio z tabeli — właściciel pomysłu w szczególności nie ma żadnej
-- polityki SELECT tutaj, więc zapytanie do tej tabeli zwróci mu zawsze pustkę.
drop policy if exists "gift_reservations_select_own" on public.gift_reservations;
create policy "gift_reservations_select_own"
  on public.gift_reservations for select
  using (auth.uid() = reserved_by);

-- Rezerwacja jest dozwolona, jeśli: (1) właściciel nie wyłączył globalnie
-- WSZYSTKICH rezerwacji na koncie (profiles.reservations_enabled — nadrzędne
-- nad wszystkim poniżej), i (2) pomysł jest widoczny dla rezerwującego przez
-- PRZYNAJMNIEJ JEDNĄ wspólną grupę z włączonymi rezerwacjami, albo jest
-- udostępniony "Wszystkim znajomym" (tam nie ma grupy do sprawdzenia, więc
-- liczy się tylko globalny przełącznik). Dodatkowo: tylko aktywne (nie
-- zarchiwizowane) pomysły, i insert zawsze zaczyna od statusu "reserved" —
-- "purchased"/"completed" da się osiągnąć wyłącznie przez UPDATE
-- (patrz trigger enforce_reservation_transition niżej).
drop policy if exists "gift_reservations_insert_not_owner" on public.gift_reservations;
create policy "gift_reservations_insert_not_owner"
  on public.gift_reservations for insert
  with check (
    auth.uid() = reserved_by
    and gift_reservations.status = 'reserved'
    and exists (
      select 1
      from public.gift_ideas i
      join public.profiles p on p.id = i.user_id
      where i.id = idea_id
        and i.user_id <> auth.uid()
        and i.status = 'active'
        and p.reservations_enabled
        and (
          -- Widoczny "dla wszystkich znajomych" pomysł nie ma grupy z
          -- reservations_enabled do sprawdzenia — rezerwacje są tam zawsze dozwolone
          -- (o ile globalny przełącznik powyżej jest włączony).
          (i.visible_to_all and public.is_friend_of(i.user_id, auth.uid()))
          or exists (
            select 1
            from public.idea_visibility iv
            join public.group_members gm on gm.group_id = iv.group_id and gm.user_id = auth.uid()
            join public.idea_groups g on g.id = iv.group_id
            where iv.idea_id = i.id
              and g.reservations_enabled
          )
        )
    )
  );

-- Zmiana statusu (reserved -> purchased / cancelled, purchased -> cancelled)
-- należy wyłącznie do osoby, która zarezerwowała — właściciel pomysłu nadal
-- nie ma tu żadnej polityki. Dozwolone przejścia pilnuje osobny trigger
-- (enforce_reservation_transition), nie sama polityka RLS.
drop policy if exists "gift_reservations_update_own" on public.gift_reservations;
create policy "gift_reservations_update_own"
  on public.gift_reservations for update
  using (auth.uid() = reserved_by)
  with check (auth.uid() = reserved_by);

-- Kasowanie rezerwacji zostało celowo wyłączone (brak polityki delete) —
-- "anulowanie" to teraz UPDATE na status = 'cancelled', żeby historia
-- rezerwacji przetrwała do momentu, gdy właściciel kliknie "Dostałem"
-- (mark_idea_received musi wiedzieć, że rezerwacja istniała).

-- Funkcje SECURITY DEFINER to jedyny bezpieczny "boczny kanał" informacji
-- o rezerwacji: dla właściciela pomysłu zawsze zwracają false, więc widzi
-- normalny produkt bez żadnej wzmianki o rezerwacji. Liczą się wyłącznie
-- statusy reserved/purchased — cancelled/completed nie są już "zajęte".
create or replace function public.is_idea_reserved(p_idea_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.gift_reservations r
    join public.gift_ideas i on i.id = r.idea_id
    where r.idea_id = p_idea_id
      and i.user_id <> auth.uid()
      and r.status in ('reserved', 'purchased')
  );
$$;

create or replace function public.is_idea_reserved_by_me(p_idea_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.gift_reservations
    where idea_id = p_idea_id
      and reserved_by = auth.uid()
      and status in ('reserved', 'purchased')
  );
$$;

revoke all on function public.is_idea_reserved(uuid) from public;
revoke all on function public.is_idea_reserved_by_me(uuid) from public;
grant execute on function public.is_idea_reserved(uuid) to authenticated;
grant execute on function public.is_idea_reserved_by_me(uuid) to authenticated;

-- Ile pomysłów danej osoby (owner) widzi dziś viewer, zgodnie z DOKŁADNIE tą
-- samą regułą widoczności co gift_ideas_select_owned_or_shared (tylko
-- aktywne — zarchiwizowany pomysł nie jest już czymś do kupienia).
create or replace function public.count_visible_active_ideas(p_owner_id uuid, p_viewer_id uuid)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::int
  from gift_ideas i
  where i.user_id = p_owner_id
    and i.status = 'active'
    and (
      p_viewer_id = p_owner_id
      or (i.visible_to_all and public.is_friend_of(p_owner_id, p_viewer_id))
      or exists (
        select 1
        from idea_visibility iv
        join group_members gm on gm.group_id = iv.group_id
        where iv.idea_id = i.id and gm.user_id = p_viewer_id
      )
    );
$$;

-- Limit aktywnych rezerwacji viewer -> owner: 1-4 widoczne pomysły => 1,
-- 5+ widocznych pomysłów => 3.
create or replace function public.active_reservation_limit(p_owner_id uuid, p_viewer_id uuid)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select case when public.count_visible_active_ideas(p_owner_id, p_viewer_id) >= 5 then 3 else 1 end;
$$;

-- Egzekwuje limit na poziomie bazy (nie da się ominąć przez bezpośrednie
-- wywołanie API) i zabezpiecza race condition: pg_advisory_xact_lock
-- serializuje równoczesne inserty tej samej pary (rezerwujący, właściciel) —
-- druga transakcja czeka, aż pierwsza się zacommituje, i dopiero wtedy liczy
-- aktywne rezerwacje na świeżo (więc widzi już wiersz z pierwszej transakcji).
create or replace function public.enforce_reservation_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_limit integer;
  v_active_count integer;
begin
  if new.status <> 'reserved' then
    return new;
  end if;

  select user_id into v_owner_id from gift_ideas where id = new.idea_id;
  if v_owner_id is null then
    raise exception 'IDEA_NOT_FOUND';
  end if;
  if v_owner_id = new.reserved_by then
    raise exception 'CANNOT_RESERVE_OWN_IDEA';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.reserved_by::text || ':' || v_owner_id::text, 0));

  v_limit := public.active_reservation_limit(v_owner_id, new.reserved_by);

  select count(*) into v_active_count
  from gift_reservations r
  join gift_ideas i on i.id = r.idea_id
  where r.reserved_by = new.reserved_by
    and i.user_id = v_owner_id
    and r.status in ('reserved', 'purchased')
    and r.id <> new.id;

  if v_active_count >= v_limit then
    raise exception 'RESERVATION_LIMIT_REACHED';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_reservation_limit on public.gift_reservations;
create trigger trg_enforce_reservation_limit
  before insert on public.gift_reservations
  for each row execute function public.enforce_reservation_limit();

-- Ogranicza dozwolone przejścia statusu i blokuje zmianę idea_id/reserved_by
-- na już istniejącym wierszu (bez tego ktoś mógłby UPDATE-em "przenieść"
-- rezerwację na inny pomysł, omijając trigger limitu, który łapie tylko INSERT).
-- app.internal_reservation_update to wewnętrzna furtka używana WYŁĄCZNIE przez
-- mark_idea_received (SECURITY DEFINER), żeby zamknąć rezerwację jako
-- completed/cancelled w imieniu właściciela — zwykły klient nigdy nie
-- ustawia tego ustawienia sesji, więc nie może sam nadać sobie "completed".
create or replace function public.enforce_reservation_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_internal boolean := coalesce(current_setting('app.internal_reservation_update', true), '') = 'true';
begin
  if new.idea_id <> old.idea_id or new.reserved_by <> old.reserved_by then
    raise exception 'RESERVATION_IMMUTABLE_FIELDS';
  end if;

  if old.status = new.status then
    return new;
  end if;

  if v_internal then
    if old.status in ('reserved', 'purchased') and new.status in ('cancelled', 'completed') then
      return new;
    end if;
    raise exception 'INVALID_RESERVATION_TRANSITION';
  end if;

  if old.status = 'reserved' and new.status in ('purchased', 'cancelled') then
    return new;
  elsif old.status = 'purchased' and new.status = 'cancelled' then
    return new;
  else
    raise exception 'INVALID_RESERVATION_TRANSITION';
  end if;
end;
$$;

drop trigger if exists trg_enforce_reservation_transition on public.gift_reservations;
create trigger trg_enforce_reservation_transition
  before update on public.gift_reservations
  for each row execute function public.enforce_reservation_transition();

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own"
  on public.notifications for select
  using (auth.uid() = recipient_id);

drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own"
  on public.notifications for update
  using (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);

-- Brak polityki insert na notifications celowo: jedyny sposób wstawienia
-- wiersza to funkcja SECURITY DEFINER (mark_idea_received), więc klient nie
-- może sfałszować cudzego powiadomienia.

-- Jedyna droga do oznaczenia pomysłu jako otrzymanego. Cała logika prywatności
-- (właściciel nigdy nie widzi kto/czy zarezerwował) żyje tutaj:
--  - gdy istniejąca rezerwacja ma status 'purchased' i owner jeszcze nie
--    potwierdził (p_confirm_purchaser is null) -> zwracamy needs_confirmation
--    = true i NIC nie zmieniamy, żeby wywołujący (klient) mógł dopiero
--    zapytać właściciela "czy to ten prezent?";
--  - w przeciwnym razie archiwizujemy pomysł i zamykamy rezerwację, wysyłając
--    najwyżej jedno neutralne powiadomienie do osoby rezerwującej.
create or replace function public.mark_idea_received(p_idea_id uuid, p_confirm_purchaser boolean default null)
returns table (needs_confirmation boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_current_status text;
  v_reservation record;
begin
  select user_id, status into v_owner_id, v_current_status
  from gift_ideas where id = p_idea_id
  for update;

  if v_owner_id is null then
    raise exception 'IDEA_NOT_FOUND';
  end if;
  if v_owner_id <> auth.uid() then
    raise exception 'NOT_IDEA_OWNER';
  end if;

  if v_current_status = 'archived' then
    return query select false;
    return;
  end if;

  select * into v_reservation
  from gift_reservations
  where idea_id = p_idea_id and status in ('reserved', 'purchased')
  limit 1;

  if v_reservation.id is not null and v_reservation.status = 'purchased' and p_confirm_purchaser is null then
    return query select true;
    return;
  end if;

  perform set_config('app.internal_reservation_update', 'true', true);

  update gift_ideas set status = 'archived', archived_at = now() where id = p_idea_id;

  if v_reservation.id is not null then
    if v_reservation.status = 'reserved' then
      update gift_reservations set status = 'cancelled' where id = v_reservation.id;
      insert into notifications (recipient_id, type, idea_id)
      values (v_reservation.reserved_by, 'gift_received_reserved', p_idea_id);
    elsif v_reservation.status = 'purchased' then
      if p_confirm_purchaser then
        update gift_reservations set status = 'completed' where id = v_reservation.id;
        insert into notifications (recipient_id, type, idea_id)
        values (v_reservation.reserved_by, 'gift_received_purchased_confirmed', p_idea_id);
      else
        -- "Nie / Nie wiem" — zamykamy neutralnie, bez potwierdzenia dopasowania
        -- i bez żadnego powiadomienia, które mogłoby zdradzić kupującemu, że
        -- to akurat jego prezent został rozpoznany jako otrzymany.
        update gift_reservations set status = 'cancelled' where id = v_reservation.id;
      end if;
    end if;
  end if;

  return query select false;
end;
$$;

revoke all on function public.mark_idea_received(uuid, boolean) from public;
grant execute on function public.mark_idea_received(uuid, boolean) to authenticated;

-- Zdjęcia profilowe: bucket jest publiczny, więc pliki i tak serwują się
-- przez publiczny URL (getPublicUrl) bez przechodzenia przez RLS na
-- storage.objects. Pełny brak polityki SELECT (jak było wcześniej) psuje
-- jednak upload z { upsert: true } — Supabase musi wtedy sprawdzić, czy plik
-- pod tą ścieżką już istnieje, a bez ŻADNEJ polityki SELECT ta wewnętrzna
-- kontrola dostaje 403 nawet dla świeżego, jeszcze nieistniejącego pliku.
-- Rozwiązanie: SELECT ograniczony do WŁASNEGO folderu użytkownika — starcza
-- do obsługi upsertu, a nie pozwala wylistować cudzych avatarów (to właśnie
-- ta szersza wersja polityki była oryginalnie usunięta przez linter Supabase).
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars_public_read" on storage.objects;

drop policy if exists "avatars_owner_select" on storage.objects;
create policy "avatars_owner_select"
  on storage.objects for select
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars_owner_insert" on storage.objects;
create policy "avatars_owner_insert"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars_owner_update" on storage.objects;
create policy "avatars_owner_update"
  on storage.objects for update
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars_owner_delete" on storage.objects;
create policy "avatars_owner_delete"
  on storage.objects for delete
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Zdjęcia pomysłów: opcjonalne, wgrywane przez właściciela pomysłu. Ten sam
-- wzorzec co avatars (w tym SELECT ograniczony do własnego folderu, od razu
-- poprawnie — patrz komentarz przy avatars_owner_select o tym, czemu upsert
-- bez tego zwraca 403).
insert into storage.buckets (id, name, public)
values ('idea-images', 'idea-images', true)
on conflict (id) do nothing;

drop policy if exists "idea_images_owner_select" on storage.objects;
create policy "idea_images_owner_select"
  on storage.objects for select
  using (bucket_id = 'idea-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "idea_images_owner_insert" on storage.objects;
create policy "idea_images_owner_insert"
  on storage.objects for insert
  with check (bucket_id = 'idea-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "idea_images_owner_update" on storage.objects;
create policy "idea_images_owner_update"
  on storage.objects for update
  using (bucket_id = 'idea-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "idea_images_owner_delete" on storage.objects;
create policy "idea_images_owner_delete"
  on storage.objects for delete
  using (bucket_id = 'idea-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- Zaproszenia do znajomych: jeden uniwersalny, wielokrotnego użytku link na
-- osobę (nie per-odbiorca). "Wygasły"/"już wykorzystany" pokrywa expires_at
-- i active — wygenerowanie nowego linku dezaktywuje poprzedni, zamiast
-- link miał być jednorazowy.
create table if not exists public.friend_invites (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  active boolean not null default true,
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now()
);

create index if not exists idx_friend_invites_owner_id on public.friend_invites(owner_id);

alter table public.friend_invites enable row level security;

drop policy if exists "friend_invites_select_own" on public.friend_invites;
create policy "friend_invites_select_own"
  on public.friend_invites for select
  using (auth.uid() = owner_id);

drop policy if exists "friend_invites_insert_own" on public.friend_invites;
create policy "friend_invites_insert_own"
  on public.friend_invites for insert
  with check (auth.uid() = owner_id);

drop policy if exists "friend_invites_update_own" on public.friend_invites;
create policy "friend_invites_update_own"
  on public.friend_invites for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- Jedyny sposób, żeby ktokolwiek (w tym niezalogowany gość, zanim założy
-- konto) zobaczył podgląd zaproszenia — bez wystawiania całej tabeli
-- friend_invites na SELECT dla anon (co pozwoliłoby wylistować wszystkie
-- zaproszenia). Zwraca tylko to, co potrzebne do wyświetlenia ekranu
-- zaproszenia, nigdy surowych wierszy.
create or replace function public.resolve_invite(p_code uuid)
returns table (
  owner_id uuid,
  owner_name text,
  owner_avatar_url text,
  is_active boolean,
  is_expired boolean,
  is_self boolean,
  already_friends boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select
    fi.owner_id,
    p.full_name,
    p.avatar_url,
    fi.active,
    (fi.expires_at < now()),
    (auth.uid() is not null and auth.uid() = fi.owner_id),
    (
      auth.uid() is not null and exists (
        select 1 from public.friendships f
        where (f.user_id = auth.uid() and f.friend_id = fi.owner_id)
           or (f.user_id = fi.owner_id and f.friend_id = auth.uid())
      )
    )
  from public.friend_invites fi
  join public.profiles p on p.id = fi.owner_id
  where fi.id = p_code;
$$;

revoke all on function public.resolve_invite(uuid) from public;
grant execute on function public.resolve_invite(uuid) to anon, authenticated;

-- ==================================================
-- ETAP PO MVP 15 — "Podrzuć pomysł"
-- ==================================================
-- Znajomy wysyła sugestię (zdjęcie/nazwa/link) drugiemu znajomemu. Odbiorca
-- może dodać ją do swoich pomysłów albo odrzucić. Prostsze niż rezerwacje —
-- brak tu niespodzianki do chronienia, więc zwykłe RLS bez SECURITY DEFINER
-- na zapis wystarczy (insert może tylko nadawca, update statusu tylko odbiorca).
create table if not exists public.idea_suggestions (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  url text,
  image_url text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  created_at timestamptz not null default now(),
  check (sender_id <> recipient_id)
);

create index if not exists idx_idea_suggestions_recipient on public.idea_suggestions(recipient_id, status);
create index if not exists idx_idea_suggestions_sender on public.idea_suggestions(sender_id);

alter table public.idea_suggestions enable row level security;

drop policy if exists "idea_suggestions_select_related" on public.idea_suggestions;
create policy "idea_suggestions_select_related"
  on public.idea_suggestions for select
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

drop policy if exists "idea_suggestions_insert_to_friend" on public.idea_suggestions;
create policy "idea_suggestions_insert_to_friend"
  on public.idea_suggestions for insert
  with check (
    auth.uid() = sender_id
    and public.is_friend_of(sender_id, recipient_id)
  );

-- Tylko odbiorca zmienia status (accepted/dismissed) — treść i strony
-- pozostają niezmienne (nic w RLS nie broni tego wprost, ale klient nigdy
-- tego nie robi; niska stawka w porównaniu do rezerwacji, więc bez triggera).
drop policy if exists "idea_suggestions_update_recipient" on public.idea_suggestions;
create policy "idea_suggestions_update_recipient"
  on public.idea_suggestions for update
  using (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);

create or replace function public.notify_idea_suggestion_received()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into notifications (recipient_id, type, related_user_id)
  values (new.recipient_id, 'idea_suggestion_received', new.sender_id);
  return new;
end;
$$;

drop trigger if exists trg_notify_idea_suggestion_received on public.idea_suggestions;
create trigger trg_notify_idea_suggestion_received
  after insert on public.idea_suggestions
  for each row execute function public.notify_idea_suggestion_received();

do $$
begin
  alter publication supabase_realtime add table public.idea_suggestions;
exception
  when duplicate_object then null;
end $$;

-- ==================================================
-- ETAP PO MVP 17 — "Wspólne prezenty"
-- ==================================================
-- GiftPlan/GiftParticipant ze specyfikacji. Bez płatności na razie (zgodnie
-- z instrukcją) — tylko organizacja: kto się dołączył, kto jeszcze nie
-- odpowiedział. Zero polityk INSERT/UPDATE dla zwykłego klienta — każda
-- zmiana idzie przez SECURITY DEFINER funkcje poniżej, żeby w jednym miejscu
-- pilnować niezmiennika "właściciel pomysłu nigdy nie jest ani twórcą, ani
-- uczestnikiem planu dla WŁASNEGO pomysłu" (dokładnie ten sam "boczny kanał"
-- do zabronienia, co przy rezerwacjach).
create table if not exists public.gift_plans (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references public.gift_ideas(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.gift_plan_participants (
  gift_plan_id uuid not null references public.gift_plans(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'invited' check (status in ('invited', 'joined', 'declined')),
  created_at timestamptz not null default now(),
  primary key (gift_plan_id, user_id)
);

create index if not exists idx_gift_plans_idea_id on public.gift_plans(idea_id);
create index if not exists idx_gift_plan_participants_user_id on public.gift_plan_participants(user_id, status);

alter table public.gift_plans enable row level security;
alter table public.gift_plan_participants enable row level security;

create or replace function public.is_gift_plan_participant(p_plan_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from gift_plan_participants
    where gift_plan_id = p_plan_id and user_id = p_user_id
  );
$$;

drop policy if exists "gift_plans_select_participant" on public.gift_plans;
create policy "gift_plans_select_participant"
  on public.gift_plans for select
  using (public.is_gift_plan_participant(id, auth.uid()));

drop policy if exists "gift_plan_participants_select_participant" on public.gift_plan_participants;
create policy "gift_plan_participants_select_participant"
  on public.gift_plan_participants for select
  using (public.is_gift_plan_participant(gift_plan_id, auth.uid()));

-- Ktoś współorganizujący prezent musi widzieć TEN KONKRETNY pomysł, nawet
-- jeśli właściciel nie udostępnił mu go bezpośrednio (grupa/wszyscy) —
-- zaproszenie do gift_plan samo w sobie jest wystarczającym powodem, ale
-- tylko dla tego jednego pomysłu, nie dla reszty pomysłów właściciela.
create or replace function public.idea_shared_via_gift_plan(p_idea_id uuid, p_viewer_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from gift_plan_participants gpp
    join gift_plans gp on gp.id = gpp.gift_plan_id
    where gp.idea_id = p_idea_id and gpp.user_id = p_viewer_id
  );
$$;

drop policy if exists "gift_ideas_select_owned_or_shared" on public.gift_ideas;
create policy "gift_ideas_select_owned_or_shared"
  on public.gift_ideas for select
  using (
    auth.uid() = user_id
    or public.idea_shared_with_me(gift_ideas.id)
    or (gift_ideas.visible_to_all and public.is_friend_of(gift_ideas.user_id, auth.uid()))
    or public.idea_shared_via_gift_plan(gift_ideas.id, auth.uid())
  );

-- Zakłada wspólny plan: twórca od razu dołącza jako 'joined'. Blokuje
-- właściciela pomysłu (nie może organizować niespodzianki dla samego siebie)
-- i wymaga, żeby pomysł był dla niego w ogóle widoczny.
create or replace function public.create_gift_plan(p_idea_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_visible_to_all boolean;
  v_plan_id uuid;
begin
  select user_id, visible_to_all into v_owner_id, v_visible_to_all from gift_ideas where id = p_idea_id;
  if v_owner_id is null then
    raise exception 'IDEA_NOT_FOUND';
  end if;
  if v_owner_id = auth.uid() then
    raise exception 'CANNOT_ORGANIZE_OWN_IDEA';
  end if;
  if not (
    public.idea_shared_with_me(p_idea_id)
    or (v_visible_to_all and public.is_friend_of(v_owner_id, auth.uid()))
  ) then
    raise exception 'IDEA_NOT_VISIBLE';
  end if;

  insert into gift_plans (idea_id, created_by) values (p_idea_id, auth.uid()) returning id into v_plan_id;
  insert into gift_plan_participants (gift_plan_id, user_id, status) values (v_plan_id, auth.uid(), 'joined');
  return v_plan_id;
end;
$$;

revoke all on function public.create_gift_plan(uuid) from public;
grant execute on function public.create_gift_plan(uuid) to authenticated;

-- Zaprasza kolejną osobę do już istniejącego planu — tylko obecny uczestnik
-- może zapraszać, tylko swojego znajomego, nigdy właściciela pomysłu.
create or replace function public.invite_to_gift_plan(p_plan_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_idea_id uuid;
  v_idea_owner uuid;
begin
  if not public.is_gift_plan_participant(p_plan_id, auth.uid()) then
    raise exception 'NOT_A_PARTICIPANT';
  end if;

  select gp.idea_id, i.user_id into v_idea_id, v_idea_owner
  from gift_plans gp
  join gift_ideas i on i.id = gp.idea_id
  where gp.id = p_plan_id;

  if v_idea_owner = p_user_id then
    raise exception 'CANNOT_INVITE_IDEA_OWNER';
  end if;
  if not public.is_friend_of(auth.uid(), p_user_id) then
    raise exception 'NOT_A_FRIEND';
  end if;

  insert into gift_plan_participants (gift_plan_id, user_id, status)
  values (p_plan_id, p_user_id, 'invited')
  on conflict (gift_plan_id, user_id) do nothing;

  insert into notifications (recipient_id, type, related_user_id, idea_id)
  values (p_user_id, 'gift_plan_invite', auth.uid(), v_idea_id);
end;
$$;

revoke all on function public.invite_to_gift_plan(uuid, uuid) from public;
grant execute on function public.invite_to_gift_plan(uuid, uuid) to authenticated;

-- Odpowiedź zaproszonego: joined albo declined. Tylko własny, wciąż
-- oczekujący ('invited') wiersz — nie da się w ten sposób zmienić cudzego
-- statusu ani odpowiedzieć drugi raz na to samo zaproszenie.
create or replace function public.respond_to_gift_plan_invite(p_plan_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update gift_plan_participants
  set status = case when p_accept then 'joined' else 'declined' end
  where gift_plan_id = p_plan_id and user_id = auth.uid() and status = 'invited';

  if not found then
    raise exception 'INVITE_NOT_FOUND';
  end if;
end;
$$;

revoke all on function public.respond_to_gift_plan_invite(uuid, boolean) from public;
grant execute on function public.respond_to_gift_plan_invite(uuid, boolean) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.gift_plan_participants;
exception
  when duplicate_object then null;
end $$;

-- Rozszerzenie listy dozwolonych typów powiadomień o zdarzenia z etapów 15 i 17.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'gift_received_reserved',
    'gift_received_purchased_confirmed',
    'friend_request_received',
    'friend_request_accepted',
    'idea_suggestion_received',
    'gift_plan_invite',
    'poll_created'
  ));

-- ==================================================
-- ETAP 8 — "Okazje" (urodziny i inne wydarzenia jako osobny model)
-- ==================================================
-- Uzupełnia (nie zastępuje!) profiles.birthday — to pole zostaje jako
-- prosty, wolnotekstowy opis na profilu. occasions to nowa, dokładniejsza
-- warstwa: prawdziwa data (można policzyć "za ile dni"), wiele okazji na
-- osobę, i kontrola widoczności per grupa — dokładnie jak w specyfikacji
-- (Occasion: id/owner_id/name/date/group_id). Traktujemy każdą okazję jako
-- coroczną (miesiąc+dzień) — to jedyny sensowny sposób liczenia "za 7 dni"
-- dla urodzin/rocznic, a custom eventy jednorazowe to rzadszy przypadek,
-- który i tak nie szkodzi przy takim uproszczeniu.
create table if not exists public.occasions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  occasion_date date not null,
  group_id uuid references public.idea_groups(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_occasions_owner_id on public.occasions(owner_id);

alter table public.occasions enable row level security;

-- Widoczność jak przy pomysłach: właściciel zawsze widzi swoje, znajomi
-- widzą jeśli okazja jest bez grupy (widoczna dla wszystkich znajomych) albo
-- jeśli należą do wskazanej grupy. Brak tu niczego do ukrycia przed
-- właścicielem (to JEGO urodziny — nie ma niespodzianki do zepsucia), więc
-- zwykłe RLS bez SECURITY DEFINER wystarczy.
drop policy if exists "occasions_select_related" on public.occasions;
create policy "occasions_select_related"
  on public.occasions for select
  using (
    auth.uid() = owner_id
    or (
      public.is_friend_of(owner_id, auth.uid())
      and (
        group_id is null
        or exists (select 1 from public.group_members gm where gm.group_id = occasions.group_id and gm.user_id = auth.uid())
      )
    )
  );

drop policy if exists "occasions_insert_own" on public.occasions;
create policy "occasions_insert_own"
  on public.occasions for insert
  with check (auth.uid() = owner_id);

drop policy if exists "occasions_delete_own" on public.occasions;
create policy "occasions_delete_own"
  on public.occasions for delete
  using (auth.uid() = owner_id);

-- ==================================================
-- ETAP PO MVP 18 — Czat (przypięty do wspólnego prezentu)
-- ==================================================
-- Celowo NIE ogólny messenger — czat istnieje tylko w kontekście
-- konkretnego gift_plan (patrz etap 17) i dziedziczy jego niezmiennik
-- prywatności: tylko uczestnicy planu, nigdy właściciel pomysłu.
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  gift_plan_id uuid not null references public.gift_plans(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_messages_gift_plan_id on public.chat_messages(gift_plan_id, created_at);

alter table public.chat_messages enable row level security;

-- is_gift_plan_participant już istnieje (etap 17) — reużywamy tego samego
-- SECURITY DEFINER, żeby uniknąć rekurencji RLS między gift_plan_participants
-- a chat_messages, i żeby nie duplikować logiki "kto jest uczestnikiem".
drop policy if exists "chat_messages_select_participant" on public.chat_messages;
create policy "chat_messages_select_participant"
  on public.chat_messages for select
  using (public.is_gift_plan_participant(gift_plan_id, auth.uid()));

drop policy if exists "chat_messages_insert_participant" on public.chat_messages;
create policy "chat_messages_insert_participant"
  on public.chat_messages for insert
  with check (
    auth.uid() = sender_id
    and public.is_gift_plan_participant(gift_plan_id, auth.uid())
  );

-- Bez update/delete — wiadomości są niezmienne (świadome uproszczenie na start).

do $$
begin
  alter publication supabase_realtime add table public.chat_messages;
exception
  when duplicate_object then null;
end $$;

-- ==================================================
-- ETAP PO MVP 19 — Ankiety
-- ==================================================
-- "Co kupujemy Kubie?" — target_id to osoba, dla której planujemy prezent,
-- i to jest DOKŁADNIE ta osoba, która nigdy nie może zobaczyć ankiety (ten
-- sam niezmiennik co przy rezerwacjach/wspólnych prezentach, tu wymuszony
-- explicit warunkiem `auth.uid() <> target_id` zamiast "po prostu brakiem
-- polityki", bo w przeciwieństwie do gift_plans/rezerwacji target MÓGŁBY
-- być też zwykłym uczestnikiem/znajomym w innym kontekście — trzeba go
-- jawnie wykluczyć, nie tylko nie dodawać dostępu).
create table if not exists public.polls (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.profiles(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  question text not null,
  group_id uuid references public.idea_groups(id) on delete set null,
  created_at timestamptz not null default now(),
  check (target_id <> created_by)
);

create table if not exists public.poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls(id) on delete cascade,
  label text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.poll_votes (
  poll_id uuid not null references public.polls(id) on delete cascade,
  option_id uuid not null references public.poll_options(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id)
);

create index if not exists idx_polls_target_id on public.polls(target_id);
create index if not exists idx_poll_options_poll_id on public.poll_options(poll_id);

alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;

drop policy if exists "polls_select_related" on public.polls;
create policy "polls_select_related"
  on public.polls for select
  using (
    auth.uid() <> target_id
    and (
      auth.uid() = created_by
      or (
        public.is_friend_of(target_id, auth.uid())
        and (
          group_id is null
          or exists (select 1 from public.group_members gm where gm.group_id = polls.group_id and gm.user_id = auth.uid())
        )
      )
    )
  );

drop policy if exists "polls_insert_own" on public.polls;
create policy "polls_insert_own"
  on public.polls for insert
  with check (
    auth.uid() = created_by
    and public.is_friend_of(target_id, created_by)
  );

-- poll_options/poll_votes nie powtarzają całego warunku widoczności — subquery
-- do "polls" i tak przechodzi przez RLS tej tabeli dla aktualnego użytkownika,
-- więc jeśli ktoś (w tym target_id) nie może zobaczyć wiersza w polls, exists()
-- poniżej zwróci false, mimo że sam siebie nie sprawdza bezpośrednio.
drop policy if exists "poll_options_select_visible_poll" on public.poll_options;
create policy "poll_options_select_visible_poll"
  on public.poll_options for select
  using (exists (select 1 from public.polls p where p.id = poll_options.poll_id));

drop policy if exists "poll_options_insert_poll_creator" on public.poll_options;
create policy "poll_options_insert_poll_creator"
  on public.poll_options for insert
  with check (exists (select 1 from public.polls p where p.id = poll_options.poll_id and p.created_by = auth.uid()));

drop policy if exists "poll_votes_select_visible_poll" on public.poll_votes;
create policy "poll_votes_select_visible_poll"
  on public.poll_votes for select
  using (exists (select 1 from public.polls p where p.id = poll_votes.poll_id));

drop policy if exists "poll_votes_insert_own" on public.poll_votes;
create policy "poll_votes_insert_own"
  on public.poll_votes for insert
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.polls p where p.id = poll_votes.poll_id)
  );

drop policy if exists "poll_votes_update_own" on public.poll_votes;
create policy "poll_votes_update_own"
  on public.poll_votes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Powiadamia znajomych (poza targetem, egzekwowane przez polls RLS) — a
-- właściwie: wysyłamy je tylko do osób, które mogą widzieć pomysł w danym
-- momencie tworzenia; upraszczamy do "wszyscy wspólni znajomi targetu bez
-- targetu samego" tylko wtedy, gdy ankieta nie ma group_id, inaczej tylko
-- członkowie tej grupy — to jest ten sam SECURITY DEFINER wzorzec co reszta.
create or replace function public.notify_poll_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipient uuid;
begin
  for v_recipient in
    select f.friend_id from friendships f where f.user_id = new.target_id
    union
    select f.user_id from friendships f where f.friend_id = new.target_id
  loop
    if v_recipient = new.target_id or v_recipient = new.created_by then
      continue;
    end if;
    if new.group_id is not null and not exists (
      select 1 from group_members gm where gm.group_id = new.group_id and gm.user_id = v_recipient
    ) then
      continue;
    end if;
    insert into notifications (recipient_id, type, related_user_id)
    values (v_recipient, 'poll_created', new.created_by);
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_notify_poll_created on public.polls;
create trigger trg_notify_poll_created
  after insert on public.polls
  for each row execute function public.notify_poll_created();

do $$
begin
  alter publication supabase_realtime add table public.poll_votes;
exception
  when duplicate_object then null;
end $$;

-- ==================================================
-- Powiadomienia z bezpośrednim odnośnikiem (gift_plan_invite -> plan,
-- poll_created -> ankieta) + uzupełnienie realtime, którego brakowało po
-- stronie klienta dla idea_suggestions/gift_plan_participants/poll_votes.
-- Bez tego kliknięcie w powiadomienie "zaproszono Cię do wspólnego prezentu"
-- albo "ktoś stworzył ankietę" nie miało dokąd nawigować, a dane (sugestia,
-- plan, głosy) potrafiły być niewidoczne w kliencie do czasu odświeżenia
-- sesji — loadSession ładuje je tylko raz, patrz CLAUDE.md.
-- ==================================================

alter table public.notifications add column if not exists gift_plan_id uuid references public.gift_plans(id) on delete set null;
alter table public.notifications add column if not exists poll_id uuid references public.polls(id) on delete set null;

create or replace function public.invite_to_gift_plan(p_plan_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_idea_id uuid;
  v_idea_owner uuid;
begin
  if not public.is_gift_plan_participant(p_plan_id, auth.uid()) then
    raise exception 'NOT_A_PARTICIPANT';
  end if;

  select gp.idea_id, i.user_id into v_idea_id, v_idea_owner
  from gift_plans gp
  join gift_ideas i on i.id = gp.idea_id
  where gp.id = p_plan_id;

  if v_idea_owner = p_user_id then
    raise exception 'CANNOT_INVITE_IDEA_OWNER';
  end if;
  if not public.is_friend_of(auth.uid(), p_user_id) then
    raise exception 'NOT_A_FRIEND';
  end if;

  insert into gift_plan_participants (gift_plan_id, user_id, status)
  values (p_plan_id, p_user_id, 'invited')
  on conflict (gift_plan_id, user_id) do nothing;

  insert into notifications (recipient_id, type, related_user_id, idea_id, gift_plan_id)
  values (p_user_id, 'gift_plan_invite', auth.uid(), v_idea_id, p_plan_id);
end;
$$;

revoke all on function public.invite_to_gift_plan(uuid, uuid) from public;
grant execute on function public.invite_to_gift_plan(uuid, uuid) to authenticated;

create or replace function public.notify_poll_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipient uuid;
begin
  for v_recipient in
    select f.friend_id from friendships f where f.user_id = new.target_id
    union
    select f.user_id from friendships f where f.friend_id = new.target_id
  loop
    if v_recipient = new.target_id or v_recipient = new.created_by then
      continue;
    end if;
    if new.group_id is not null and not exists (
      select 1 from group_members gm where gm.group_id = new.group_id and gm.user_id = v_recipient
    ) then
      continue;
    end if;
    insert into notifications (recipient_id, type, related_user_id, poll_id)
    values (v_recipient, 'poll_created', new.created_by, new.id);
  end loop;
  return new;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.gift_plans;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.polls;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.poll_options;
exception
  when duplicate_object then null;
end $$;

-- Relikt oryginalnego prototypu (Lovable): domyślne miasto 'Warszawa' na
-- profilach, w parze z fałszywą datą urodzenia "12 marca 1994" z mock-data.ts
-- (patrz CLAUDE.md). Klient i tak zawsze jawnie wysyła null, gdy użytkownik
-- nie poda miasta (insert profilu w loadSession), więc ten default nigdy nie
-- powinien się uruchomić przez normalny przepływ aplikacji — usunięty dla
-- czystości i żeby nikt przypadkiem nie dodał kiedyś insertu bez tej kolumny.
alter table public.profiles alter column city drop default;
