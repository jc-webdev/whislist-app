# Pełny cykl życia prezentu — podsumowanie wdrożenia (2026-09-06)

> Aktualizacja tego samego dnia: druga tura zmian (widoczność "Wszyscy
> znajomi", zdjęcia pomysłów, custom confirm dialogi, powiadomienia z
> zakładkami + realtime, poprawka uploadu avatara) opisana na końcu pliku,
> w sekcji **"Druga tura — UX i rozszerzenia (ten sam dzień)"**.
>
> **Trzecia tura (noc 6→7.09.2026, praca autonomiczna)**: poprawki 4 bugów
> zgłoszonych przed snem + trzy etapy post-MVP z instrukcja.txt (15, 16, 17).
> Opisana w sekcji **"Trzecia tura — nocne poprawki i ETAP PO MVP 15/16/17"**
> na samym końcu pliku. **STATUS: migracja wgrana, wszystko zweryfikowane —
> 23/23 testy backendowe (`gift-lifecycle.test.mjs` 16/16 bez regresji +
> `post-mvp.test.mjs` 7/7) i pełna weryfikacja UI przez Playwright na trzech
> prawdziwych kontach dla każdej z 4 poprawek i 3 nowych funkcji, ze
> zrzutami ekranu.** SQL napisany "na ślepo" (bez możliwości testu w
> trakcie pisania) okazał się poprawny za pierwszym razem — jedyna
> znaleziona usterka była po stronie klienta (patrz Bug 3 niżej, opisana
> poprawka do poprawki znaleziona przy weryfikacji na żywo).

Rozbudowa istniejącego systemu rezerwacji o pełny lifecycle:
**Pomysł → Rezerwacja → Kupione → Dostałem ❤️ → Archiwum**.

Zero nowej równoległej architektury — wszystko dobudowane na istniejących
tabelach (`gift_ideas`, `gift_reservations`), istniejących wzorcach RLS
(`SECURITY DEFINER` funkcje omijające rekurencję/ujawnianie danych) i
istniejącym UI (`DetailScreen`, `ProfileScreen`, wzorzec `summary-link`,
wzorzec dzwoneczka z badge z systemu zaproszeń).

## Model danych

**`gift_ideas`** — dodane kolumny (addytywnie, `default 'active'`, więc
istniejące rekordy się nie zmieniają):
- `status text` (`active` / `archived`)
- `archived_at timestamptz`

**`gift_reservations`** — dodana kolumna `status text` (`reserved` /
`purchased` / `cancelled` / `completed`), domyślnie `'reserved'` (czyli
dokładnie taki stan, w jakim istniejące rezerwacje faktycznie były).

Krytyczna zmiana: oryginalny `unique(idea_id)` na `gift_reservations`
uniemożliwiał na zawsze ponowną rezerwację po anulowaniu (jeden wiersz zajmował
unikalność `idea_id` bezterminowo). Zamieniony na **częściowy unique index**
(`where status in ('reserved','purchased')`) — tylko jedna aktywna rezerwacja
na pomysł naraz, ale historia (`cancelled`/`completed`) nie blokuje kolejnej.
Usunięta też polityka DELETE na `gift_reservations` — „anulowanie” to teraz
zawsze UPDATE na `status='cancelled'`, żeby historia przetrwała do momentu,
gdy właściciel kliknie „Dostałem” (musi wiedzieć, że rezerwacja istniała).

**Nowa tabela `notifications`** (nie istniała wcześniej żadna generyczna
tabela powiadomień — jedyny wcześniejszy „system” to badge liczący
`friend_requests`). Klient **nie ma prawa INSERT** — jedyny sposób dodania
wiersza to funkcja `SECURITY DEFINER`, więc nie da się sfałszować cudzego
powiadomienia ani go podejrzeć (RLS: SELECT/UPDATE tylko `recipient_id = auth.uid()`).

## Limit aktywnych rezerwacji (1–4 widoczne pomysły → 1, 5+ → 3)

Egzekwowany **wyłącznie w bazie**, nie w UI:

- `count_visible_active_ideas(owner, viewer)` — liczy pomysły danej osoby
  widoczne dla viewera dokładnie tą samą regułą co polityka SELECT na
  `gift_ideas` (przez `idea_visibility`/`group_members`), tylko `status='active'`.
- `active_reservation_limit(owner, viewer)` — 1 lub 3 wg progu.
- Trigger `BEFORE INSERT` (`enforce_reservation_limit`) na `gift_reservations`:
  liczy aktywne rezerwacje viewer→owner i odrzuca insert (`RESERVATION_LIMIT_REACHED`),
  jeśli limit osiągnięty. Ponieważ to trigger na tabeli (nie kod aplikacji),
  **nie da się go ominąć przez bezpośrednie wywołanie API**.
- **Race conditions**: `pg_advisory_xact_lock` na hashu pary (rezerwujący,
  właściciel) serializuje równoczesne inserty tej samej pary — druga transakcja
  czeka na commit pierwszej i dopiero wtedy liczy na świeżo. Zweryfikowane
  testem (dwa równoczesne inserty, dokładnie jeden przechodzi).
- Trigger `BEFORE UPDATE` (`enforce_reservation_transition`) pilnuje
  dozwolonych przejść statusu i blokuje zmianę `idea_id`/`reserved_by` na
  istniejącym wierszu (żeby nie dało się „przenieść” rezerwacji na inny
  pomysł, omijając trigger limitu, który łapie tylko INSERT).

## Prywatność (właściciel nigdy nic nie widzi)

Bez zmian w fundamentalnym wzorcu — rozszerzony na nowe pola:
- `gift_reservations` nadal nie ma żadnej polityki SELECT dla właściciela.
- `is_idea_reserved`/`is_idea_reserved_by_me` zaktualizowane, żeby liczyć
  tylko `status in ('reserved','purchased')` (anulowana/zakończona rezerwacja
  przestaje „zajmować” pomysł).
- Cała logika „Dostałem” (w tym rozpoznanie, czy istniała rezerwacja
  `purchased`, i decyzja czy wysłać powiadomienie) żyje w jednej funkcji
  `SECURITY DEFINER` — `mark_idea_received` — żeby właściciel fizycznie nie
  mógł odpytać `gift_reservations` z klienta w trakcie tego procesu.
- Test potwierdza: `owner.client.from("gift_reservations").select()` zawsze
  zwraca `[]`, niezależnie od stanu rezerwacji.

## RPC `mark_idea_received(p_idea_id, p_confirm_purchaser default null)`

Jedyna droga oznaczenia pomysłu jako otrzymanego:

1. Weryfikuje, że `auth.uid()` jest właścicielem (inaczej `NOT_IDEA_OWNER`).
2. Jeśli istnieje rezerwacja `purchased` i `p_confirm_purchaser is null` →
   zwraca `needs_confirmation = true` i **niczego nie zmienia** — to sygnał
   dla klienta, żeby dopiero zapytać właściciela „czy to ten prezent?”.
3. W przeciwnym razie: archiwizuje pomysł (`status='archived'`,
   `archived_at=now()`) i zamyka rezerwację:
   - `reserved` → `cancelled` + powiadomienie `gift_received_reserved` dla
     rezerwującego („Ktoś już dostał ten prezent…”).
   - `purchased` + potwierdzenie `true` → `completed` + powiadomienie
     `gift_received_purchased_confirmed` („[Imię] dostał Twój prezent!”).
   - `purchased` + potwierdzenie `false` (Nie/Nie wiem) → `cancelled`,
     **bez żadnego powiadomienia** (żeby nie zdradzić kupującemu, że to
     akurat jego prezent rozpoznano jako otrzymany).
4. Wewnętrzna furtka `set_config('app.internal_reservation_update', 'true', true)`
   pozwala tej funkcji (i tylko jej) ustawić `completed`/zamknąć `purchased` —
   zwykły klient przez UPDATE nigdy nie osiągnie `completed` sam.

## UI (AppShell.tsx) — dopięte do istniejących ekranów

- **`DetailScreen`**: przyciski zależne od stanu (`Zarezerwuj` / `✓ Kupione` +
  `Anuluj rezerwację` / `❤️ Dostałem`), status „❤️ Otrzymany” dla
  zarchiwizowanych. Potwierdzenia przez `window.confirm` — dokładnie ten sam
  wzorzec co istniejące „Usunąć ten pomysł?”/„Usunąć konto?”, żeby nie
  wprowadzać nowego komponentu modala.
  **[AKTUALIZACJA — patrz druga tura niżej]:** `window.confirm` zostało
  później zastąpione własnym dialogiem (`askConfirm`/`.confirm-dialog`) na
  życzenie użytkownika — ten akapit opisuje już nieaktualny stan.
- **Archiwum** — nowy ekran (`/archive`), wpięty jak istniejący link „Moje
  aktywne pomysły” w profilu (wzorzec `summary-link`). Reużywa
  `IdeasScreen`/`IdeaCard` bez zmian strukturalnych.
- **Powiadomienia** — nowy ekran (`/notifications`) + dzwoneczek z badge na
  ekranie Pomysły — dokładnie ten sam komponent wizualny (`IconBell`,
  `.bell-button`, `.bell-badge`), co istniejący dzwoneczek zaproszeń do
  znajomych na ekranie Ludzie (osobny, niezmieniony — to inna domena).

## Testy

Projekt nie ma frameworka testowego (brak jest/vitest) — zgodnie z ustaloną
konwencją (`create-demo-users.mjs`) testy to zwykłe skrypty Node uderzające w
prawdziwy projekt Supabase, z `node:assert/strict`.

`supabase/tests/gift-lifecycle.test.mjs` — 16 testów, wszystkie zielone:
limity (1/4/5/10 widocznych pomysłów, anulowanie zwalnia limit, prywatne
pomysły nie liczą się), rezerwacje (brak obejścia przez API, race condition,
prywatność właściciela), kupione (przejście statusu, widoczność tylko dla
kupującego), dostałem (archiwizacja, blokada ponownej rezerwacji, tylko
właściciel), powiadomienia (wszystkie warianty z sekcji 12 specyfikacji).

Uruchomienie: `node supabase/tests/gift-lifecycle.test.mjs` z katalogu
`supabase/` (wymaga `supabase/.env`; dodano lokalny `package.json`/
`node_modules` z `@supabase/supabase-js` tylko dla tego katalogu narzędziowego).

Dodatkowo pełna weryfikacja e2e przez Playwright (dwa prawdziwe konta,
prawdziwa grupa, prawdziwy pomysł) potwierdziła cały flow wizualnie: rezerwacja
→ kupione → „Dostałem” z dwoma dialogami potwierdzenia → pozytywne
powiadomienie u kupującego → pomysł w archiwum ze statusem „Otrzymany”, przez
cały czas bez jakiegokolwiek śladu rezerwacji w widoku właściciela.

## Znane uproszczenia / świadomie odłożone

- Brak automatycznego wygasania rezerwacji (`reserved`/`purchased` bez
  limitu czasowego) — jak prosiła specyfikacja, nie wdrożone teraz.
- ~~Powiadomienia ładują się raz przy starcie sesji... nie ma realtime/pollingu~~
  — **nieaktualne, patrz druga tura: dodano Supabase Realtime.**
- `is_idea_reserved_by_me` RPC został poprawiony (filtruje `cancelled`/
  `completed`), ale w praktyce już nieużywany przez klienta — status własnej
  rezerwacji UI czyta teraz bezpośrednio z `myReservations` (mniej round-tripów).
  Funkcja została w schemacie nietknięta poza tą poprawką, żeby nie zwiększać
  ryzyka zmiany niezwiązanego kodu.

---

## Druga tura — UX i rozszerzenia (ten sam dzień)

Seria mniejszych, niezależnych poprawek zgłoszonych po pierwszym wdrożeniu.

### 1. Widoczność „Wszyscy znajomi”

Trzecia kategoria obok „tylko ja” i „wybrane grupy”: `gift_ideas.visible_to_all
boolean` (domyślnie `false`, więc nic się nie zmienia dla istniejących
pomysłów). Wymagało dotknięcia trzech miejsc w RLS, żeby zachować spójność z
resztą modelu:
- `gift_ideas_select_owned_or_shared` — dodany trzeci warunek: `visible_to_all
  AND is_friend_of(owner, viewer)` (nowa funkcja `SECURITY DEFINER`, ten sam
  wzorzec co `idea_shared_with_me`).
- `count_visible_active_ideas` (limit rezerwacji) — pomysły „dla wszystkich”
  też muszą się liczyć do limitu 1/3, inaczej dałoby się go obejść.
- `gift_reservations_insert_not_owner` — pomysł „dla wszystkich” nie ma grupy
  z `reservations_enabled`, więc rezerwacja jest tam zawsze dozwolona (brak
  przełącznika do sprawdzenia).

UI: w `AddIdeaScreen` chip „🌍 Wszyscy znajomi” wzajemnie wykluczający się z
„Tylko ja” i konkretnymi grupami. Zweryfikowane osobnym skryptem testowym
(`test_visible_to_all.mjs` w scratchpadzie sesji, nie w repo) — znajomy widzi
i może zarezerwować, obcy nie widzi i nie może.

### 2. Link do sklepu jako przycisk + auto-detekcja nazwy

`DetailScreen` pokazywał wcześniej surowy URL jako tekst. Teraz to przycisk
(`.store-link-button`, `target="_blank" rel="noreferrer"`) z ikoną SVG
(`IconExternalLink`, ten sam styl co reszta ikon w `LandingScreen`/dzwoneczku).
Nazwa sklepu zgadywana z domeny linku (`guessStoreFromUrl` — bierze drugi od
końca segment domeny, np. `empik.com` → „Empik”) i automatycznie wpisywana w
pole „Sklep” w formularzu, jeśli użytkownik go jeszcze nie uzupełnił ręcznie
(nie nadpisuje ręcznej zmiany). Fallback zastosowany też w `toIdea` dla
starych pomysłów bez zapisanej nazwy sklepu.

### 3. Poprawka nawigacji po onboardingu (pierwszy pomysł → martwy ekran)

Bug: `submitIdea` zawsze robi `router.replace('/ideas/{id}')`, ale wywołane z
poziomu onboardingu zastępowało to jedyny wpis historii sprzed zalogowania —
przycisk „Wróć” prowadził donikąd (ekran logowania już nie istniał, bo sesja
była aktywna). Naprawione przez dodanie `router.replace("/")` na końcu
`onAddFirstIdea` w `AppShell` — po dodaniu pierwszego pomysłu w onboardingu
użytkownik ląduje wprost na liście pomysłów, a nie na jego szczególe, więc nie
ma czego „cofać”. Zweryfikowane e2e: świeże konto → onboarding → dodanie
pomysłu → ląduje na `/` z widocznym pomysłem.

Przy okazji: wszystkie przyciski „Wróć”/„Wróć do ludzi”/„Wróć do profilu” w
nagłówkach oraz w `DetailScreen`/`ProfileScreen` dostały ikonę strzałki
(`IconArrowLeft`) — nowy współdzielony komponent `BackButton` w miejscach
sterowanych z `AppShell`, inline SVG tam gdzie komponent bierze `onClick` jako
prop.

### 4. Custom confirm dialog zamiast `window.confirm`

Nowy stan globalny w `AppShell` (`confirmRequest` + `askConfirm(opts):
Promise<boolean>` + `resolveConfirm`) renderowany jako `.confirm-overlay` /
`.confirm-dialog` na końcu drzewa aplikacji — działa niezależnie od aktualnego
ekranu. Zastąpił **wszystkie** dotychczasowe `window.confirm`: usuwanie
pomysłu, usuwanie konta, wylogowanie (nowe — wcześniej nie miało potwierdzenia
w ogóle), „Dostałem ❤️” (oba kroki: podstawowe pytanie i pytanie o
potwierdzenie osoby kupującej), anulowanie rezerwacji `purchased`. Zweryfikowane
Playwright-em z nasłuchem na natywne zdarzenie `dialog` — ani razu nie
odpaliło się przeglądarkowe okno, wszystko przechodzi przez własny komponent.

### 5. Powiadomienia: zakładki + zdarzenia społecznościowe + Realtime

- **Zakładki** „Wszystkie” / „Zaproszenia” w `NotificationsScreen` (wzorzec
  `.tab-row` z `PeopleScreen`). Zakładka Zaproszenia renderuje dokładnie tę
  samą listę otrzymanych/wysłanych zaproszeń co dotychczasowy ekran
  `/people/requests` (który został — celowo — bez zmian, więc nadal działa
  jako dodatkowy skrót z zakładki Ludzie; nic nie zepsute, tylko dodana druga
  droga dostępu do tych samych danych).
- **Nowe typy powiadomień**: `friend_request_received` (trigger `AFTER
  INSERT` na `friend_requests`, więc odbiorca dostaje powiadomienie
  natychmiast, niezależnie od tego, jaką drogą zaproszenie powstało) i
  `friend_request_accepted` (nowa funkcja `accept_friend_request` — jedna
  atomowa operacja insert-friendships + delete-request + insert-notification,
  zastąpiła dwa osobne zapytania z klienta). Dodana kolumna
  `notifications.related_user_id` (kto), bo `idea_id` nie miało tu sensu.
- **Realtime**: `alter publication supabase_realtime add table` dla
  `notifications` i `friend_requests` + jeden kanał Supabase Realtime na
  sesję (`postgres_changes`, filtrowany po `recipient_id` gdzie to możliwe;
  DELETE bez filtra, bo replica identity domyślnie nie niesie innych kolumn
  w `old` poza kluczem głównym). RLS obowiązuje też na Realtime, więc klient
  fizycznie nie dostanie cudzych zdarzeń. Zweryfikowane e2e: wstawienie
  `friend_requests` wprost przez service-role, podczas gdy strona
  użytkownika była już otwarta — badge dzwoneczka zmienił się na „1” bez
  żadnego odświeżenia strony.

### 6. Poprawka uploadu avatara (400/RLS przy `upsert: true`)

Realny bug zgłoszony przez użytkownika (log z konsoli: `400 Bad Request` na
`storage/v1/object/avatars/...`). Przyczyna: wcześniejsza sesja usunęła
**całą** politykę SELECT na `storage.objects` dla bucketu `avatars` (żeby
naprawić ostrzeżenie lintera Supabase o możliwości wylistowania wszystkich
plików). Efekt uboczny: `upload(..., { upsert: true })` musi sprawdzić, czy
plik pod daną ścieżką już istnieje, a bez ŻADNEJ polityki SELECT ta wewnętrzna
kontrola dostawała 403 nawet dla świeżego, jeszcze nieistniejącego pliku.
Naprawione dodaniem polityki SELECT ograniczonej do własnego folderu
użytkownika (`avatars_owner_select`) — wystarcza do obsługi upsertu, nie
przywraca możliwości wylistowania cudzych avatarów (to węższy zakres niż to,
co linter faktycznie krytykował). Zweryfikowane bezpośrednim wywołaniem
`storage.upload` z `upsert: true` — przed poprawką `403/AccessDenied`, po
poprawce sukces.

### 7. Opcjonalne zdjęcie pomysłu + miniaturka w liście

Nowy bucket `idea-images` (ten sam wzorzec RLS co `avatars`, tym razem od razu
z polityką SELECT, żeby nie powtórzyć błędu z punktu 6). `Idea.image` jest
teraz `string | null` zamiast zawsze mieć fallback na stockowe zdjęcie z
Unsplash — brak zdjęcia to świadomy, widoczny stan, nie ukryty za losową
fotografią wnętrza.
- `AddIdeaScreen`: pole „Zdjęcie (opcjonalnie)” — `<input type="file">` z
  podglądem (`URL.createObjectURL`, sprzątane przez `revokeObjectURL` w
  cleanupie efektu) i przyciskiem „Usuń zdjęcie”. Upload dzieje się w
  `submitIdea` tuż przed insertem/update (nowy plik → upload → publiczny URL
  → zapis w `image_url`; brak nowego pliku → zachowany istniejący URL albo
  `null`, jeśli usunięty).
- `IdeaCard`: bez zdjęcia karta nie renderuje `.idea-image-wrap` w ogóle
  (klasa `.idea-card.no-image`) — mniejsza wysokość wynika naturalnie z braku
  zarezerwowanej przestrzeni na obrazek, bez dodatkowego CSS poza drobną
  korektą paddingu. Odznaka „🔒 Zarezerwowane” w tym wariancie przenosi się do
  wiersza priorytetu zamiast nakładki na zdjęcie, którego nie ma.
- `DetailScreen`: hero-image analogicznie znika całkowicie, gdy `idea.image`
  jest `null`, zamiast pokazywać fasadowe zdjęcie zastępcze.

### 8. Drobne poprawki UI

- Nagłówek „Co ostatnio wpadło Ci w oko?” dostał własną klasę
  (`.ideas-heading`, `font-size: 18px`, selektor `.topbar h1.ideas-heading`
  żeby wygrać specificity z ogólną regułą `.topbar h1`) — nie zmienia
  rozmiaru innych nagłówków ekranów.
- Grupy: dodawanie nowych członków do **już istniejącej** grupy już
  działało w kodzie (`inviteToGroup` + UI „Zaproś” w `PeopleScreen`) —
  zweryfikowane e2e, że faktycznie działa (utworzono grupę, dodano do niej
  drugiego użytkownika już po utworzeniu). Zgłoszenie okazało się nie wymagać
  zmian kodu, tylko potwierdzenia, że funkcja jest sprawna.

### Migracja i testy tej tury

Wszystko w `supabase/schema.sql` (jeden, w pełni idempotentny plik, wklejony
przez użytkownika do SQL Editora — jak zawsze w tym projekcie). Nowe testy
backendowe napisane ad-hoc w scratchpadzie sesji (nie trafiły do repo, w
odróżnieniu od `gift-lifecycle.test.mjs`): widoczność `visible_to_all`
(4 asercje) i `accept_friend_request` RPC (6 asercji, w tym próba
zaakceptowania cudzego zaproszenia). `gift-lifecycle.test.mjs` przechodzi bez
zmian (16/16) — potwierdza brak regresji w pierwszej turze. Pełna weryfikacja
UI przez Playwright na dwóch/trzech prawdziwych kontach dla każdej z ośmiu
zmian powyżej, ze zrzutami ekranu.

---

## Trzecia tura — nocne poprawki i ETAP PO MVP 15/16/17

Zaczęte jako praca autonomiczna bez możliwości weryfikacji na żywo w
Supabase (brak dostępu do SQL Editora/CLI/connection stringa poza kluczami
REST) — kod napisany "na ślepo". Po przebudzeniu użytkownik wkleił
`schema.sql`, po czym **wszystko zostało w pełni zweryfikowane**:

- `gift-lifecycle.test.mjs` — 16/16, bez regresji.
- `post-mvp.test.mjs` (nowy plik z tej tury) — 7/7 za pierwszym uruchomieniem.
- Pełna weryfikacja UI przez Playwright na trzech prawdziwych kontach,
  ze zrzutami ekranu, dla każdej z 4 poprawek i 3 nowych funkcji — w tym
  test niezmiennika prywatności end-to-end (właściciel pomysłu nie widzi ani
  śladu rezerwacji, ani wspólnego planu, przez cały flow).

Jedyna usterka znaleziona przy weryfikacji na żywo (nie w SQL, tylko po
stronie klienta) — patrz Bug 3 niżej, sekcja "Poprawka do poprawki".

### Bug 1: "Właściciel wyłączył rezerwacje" mimo grupy z włączonymi rezerwacjami

Odtworzone i potwierdzone: `selectedIdeaOwnerAllowsReservations` (czysto
kliencka funkcja decydująca co pokazać) nie uwzględniała pomysłów
`visible_to_all` ("Wszyscy znajomi") — dla takich pomysłów `idea.visibility`
jest zawsze pustą tablicą (brak wierszy w `idea_visibility`, bo ta kategoria
w ogóle nie używa grup), więc funkcja zawsze zwracała `false`. Zwykła
rezerwacja przez konkretną grupę (dokładnie taki scenariusz jak opisany:
grupa z domyślnie włączonymi rezerwacjami + dodany członek) **działała
poprawnie już wcześniej** — odtworzyłem to osobno i przeszło. Prawdopodobnie
w praktyce chodziło o pomysł udostępniony jako "Wszyscy znajomi" (najnowsza,
najchętniej testowana funkcja), niekoniecznie o samą grupę. Naprawione:
`selectedIdeaOwnerAllowsReservations` teraz explicitly zwraca `true` dla
`visibleToAll`, zgodnie z tym, co i tak już pozwalała polityka RLS.

### Bug 2: brak globalnego przełącznika rezerwacji w ustawieniach profilu

Przy okazji naprawy buga 1 wyszła też realna luka architektoniczna: pomysły
"Wszyscy znajomi" nie mają ŻADNEJ grupy do przełączenia — właściciel takiego
pomysłu nie miał żadnego sposobu na wyłączenie dla nich rezerwacji. Rozwiązanie:
przywrócona kolumna `profiles.reservations_enabled` (nazwa identyczna jak
usunięta wcześniej w tym projekcie kolumna, ale inna rola — **teraz to
nadrzędny master-switch, nie jedyny mechanizm**). Domyślnie `true`. Nowy
toggle w `PrivacyScreen` ("Rezerwacje pomysłów (wszystkie)"). Wyłączenie
blokuje rezerwacje na WSZYSTKICH pomysłach właściciela, niezależnie od
ustawień per-grupa i `visible_to_all` — wymuszone w tej samej polityce RLS
insertu na `gift_reservations` (dodatkowy `join profiles p ... and
p.reservations_enabled`), więc nie da się tego obejść przez bezpośrednie
wywołanie API.

### Bug 3: edycja pomysłu → zapisz → "Wróć" wymaga dwóch kliknięć

Root cause: edycja przychodziła z `router.push("/ideas/{id}/edit")` wywołanego
z widoku szczegółów TEGO SAMEGO pomysłu. Po zapisie kod robił
`router.replace("/ideas/{id}")` — czyli w historii przeglądarki powstawały
DWA kolejne wpisy o **identycznym** URL-u (ten sprzed edycji i ten podmieniony
przez replace). Next.js App Router nie wykrywa nawigacji, gdy `pathname` się
nie zmienia (nawet jeśli faktyczny indeks w historii przesunął się o jeden) —
stąd pierwsze kliknięcie "Wróć" wizualnie nic nie robiło, dopiero drugie
(cofające do NAPRAWDĘ innego URL-a) działało.

**Pierwsza wersja poprawki** (napisana przed testem na żywo): dla edycji
`submitIdea` miał wołać `router.back()` zamiast `replace`. Działało dla
normalnego flow (kliknięcie "Edytuj pomysł" z widoku szczegółów), ale
weryfikacja na żywo (dwa scenariusze w Playwright: przez UI i przez
bezpośrednią nawigację na URL edycji) wykryła lukę: jeśli ktoś trafił na
ekran edycji BEZ uprzedniego wejścia na widok szczegółów w tej samej sesji
przeglądania (np. odświeżenie strony na URL-u edycji, bezpośredni link),
`router.back()` cofał do zupełnie przypadkowego wcześniejszego URL-a, nie do
widoku szczegółów.

**Poprawka do poprawki (ostateczne rozwiązanie):** zamiast zgadywać, dokąd
cofnąć, `goToEditIdea` wchodzi w tryb edycji przez `router.replace` (nie
`push`) — edycja zajmuje TEN SAM slot w historii co widok szczegółów, zamiast
dokładać nowy wpis. Dzięki temu `submitIdea` może zawsze bezwarunkowo wołać
`router.replace("/ideas/{id}")` (ten sam kod dla nowego i edytowanego
pomysłu, żadnego rozgałęzienia) — nigdy nie powstają dwa kolejne wpisy z tym
samym URL-em, bez względu na to, jak użytkownik trafił na ekran edycji.
Zweryfikowane oboma scenariuszami w Playwright: wejście przez UI i
bezpośrednia nawigacja na URL edycji — oba lądują poprawnie za jednym
kliknięciem "Wróć".

### Bug 4: popup "Dostałeś ten prezent?" ma widoczne prześwitywanie tła

`.confirm-dialog` używał `var(--card)` (`rgba(255,255,255,0.8)`, celowo
półprzezroczysty token do glassmorphic kart na tle gradientu) na tle
`.confirm-overlay` (`rgba(20,28,26,0.45)`) — dwie przezroczystości nakładające
się dawały widoczne prześwitywanie. Zmienione na stały, nieprzezroczysty kolor
(`#fbfdfc`).

### ETAP PO MVP 15 — "Podrzuć pomysł"

Nowa tabela `idea_suggestions` (sender/recipient/title/url/image_url/status).
Prostsze niż rezerwacje pod względem prywatności — nie ma tu niespodzianki do
chronienia — więc zwykłe RLS bez `SECURITY DEFINER` na zapis: insert tylko od
znajomego (`is_friend_of`), update statusu tylko przez odbiorcę. Trigger
`AFTER INSERT` tworzy powiadomienie `idea_suggestion_received` (ten sam
wzorzec co `friend_request_received`). Zaakceptowanie sugestii to zwykły
insert do `gift_ideas` przez odbiorcę (już i tak dozwolony) + update statusu —
bez RPC, bo nie ma tu nic do ukrywania między stronami.

UI: przycisk "💡 Podrzuć pomysł" na profilu znajomego → prosty formularz
(zdjęcie opcjonalne, nazwa, link — bez ceny/priorytetu/komentarza, bo to
tylko sugestia) → `/people/{id}/suggest`. Odbiór: nowa zakładka "Sugestie" w
Powiadomieniach (obok Wszystkie/Zaproszenia), z sekcją otrzymanych
(Dodaj/Odrzuć) i wysłanych (status).

### ETAP PO MVP 16 — "Znajdź prezent"

Zero zmian w bazie — czysto kliencki wizard w `GiftsScreen` (zakładka
"Prezenty"): wybór znajomego + opcjonalny budżet, filtruje już wczytane
`effectiveFriendIdeas` po cenie, sortuje priorytetem (Bardzo chcę najpierw).
Celowo **bez** "produktów powiązanych"/"alternatywnych ofert" — to zgodnie z
`instrukcja.txt` i `monetyzacja.txt` należy do przyszłej fazy monetyzacyjnej,
nie do zbudowania teraz.

### ETAP PO MVP 17 — "Wspólne prezenty"

Najbardziej złożona z trzech — bo dotyczy tego samego niezmiennika prywatności
co rezerwacje: **właściciel pomysłu nigdy nie może wiedzieć, że ktoś
organizuje dla niego wspólny zakup, ani kto w tym uczestniczy**. Nowe tabele
`gift_plans` (id/idea_id/created_by) i `gift_plan_participants`
(gift_plan_id/user_id/status: invited/joined/declined) — **zero polityk
INSERT/UPDATE dla klienta w ogóle**, wszystkie zmiany idą przez trzy funkcje
`SECURITY DEFINER`:

- `create_gift_plan(idea_id)` — blokuje właściciela pomysłu i wymaga, żeby
  pomysł był faktycznie widoczny dla wywołującego (reużywa
  `idea_shared_with_me`/`visible_to_all`+`is_friend_of` — bez tego dałoby się
  założyć plan dla dowolnego zgadniętego UUID pomysłu, nawet prywatnego).
- `invite_to_gift_plan(plan_id, user_id)` — tylko obecny uczestnik może
  zapraszać, tylko swojego znajomego, nigdy właściciela pomysłu. Tworzy
  powiadomienie `gift_plan_invite`.
- `respond_to_gift_plan_invite(plan_id, accept)` — działa tylko na własnym,
  wciąż `invited` wierszu (nie da się odpowiedzieć drugi raz ani zmienić
  cudzego statusu).

Dodatkowa, nietrywialna poprawka widoczności: uczestnik planu **musi** widzieć
pomysł, którego plan dotyczy, nawet jeśli właściciel nie udostępnił mu go
bezpośrednio (bo zaprosił go ktoś inny, kto miał dostęp). Nowa funkcja
`idea_shared_via_gift_plan` dodana jako czwarty warunek OR w polityce SELECT
na `gift_ideas` — celowo zawężona do TEGO JEDNEGO pomysłu przez join przez
`gift_plan_participants`/`gift_plans`, nie do wszystkich pomysłów właściciela.

UI: przycisk "🤝 Zorganizujcie razem" w widoku pomysłu znajomego (zamienia się
w "Zobacz wspólną organizację", jeśli plan już istnieje) → `/gift-plans/{id}`
z listą uczestników i statusów + możliwością zaproszenia kolejnej osoby.
Lista wszystkich moich planów (`/gift-plans`) wpięta jak Archiwum — nowy
summary-link "Wspólne prezenty" w profilu. Czerwona kropka na ikonie
"Prezenty" w dolnej nawigacji, gdy czeka nieodpowiedziane zaproszenie —
dokładnie ten sam wzorzec co kropka na "Ludzie" dla zaproszeń do znajomych.

Celowo NIE zaimplementowane (zgodnie z `instrukcja.txt`, punkt 17: "Nie
implementować płatności na początku"): podział kosztów, śledzenie wpłat,
płatności. Plan to na razie czysto lista "kto się dołączył".

### Nowe pliki tej tury

- `supabase/tests/post-mvp.test.mjs` — nieuruchomiony jeszcze (patrz wyżej).
- Trasy: `src/app/people/[id]/suggest/page.tsx`, `src/app/gift-plans/page.tsx`,
  `src/app/gift-plans/[id]/page.tsx` — te same puste placeholdery co reszta
  (`return null`), zgodnie z architekturą opisaną w CLAUDE.md.

### Wynik weryfikacji (wszystko potwierdzone, nic z listy poniżej nie było problemem)

Przed uruchomieniem migracji spisałem trzy miejsca, gdzie spodziewałem się
ewentualnej literówki/błędu logicznego, skoro SQL powstał bez możliwości
sprawdzenia. Wszystkie trzy okazały się poprawne za pierwszym razem:
- Kolumny w insertach do `notifications` z `invite_to_gift_plan`
  (`recipient_id, type, related_user_id, idea_id`) — ✅ potwierdzone testem
  (`friendBNotifications[0].idea_id === idea`).
- `create_gift_plan` zwraca gołe `uuid` przez `.rpc()` bez `.single()` — ✅
  potwierdzone, `const { data: planId } = await ...rpc(...)` działa jak
  napisano.
- Czwarta z rzędu wersja polityki `gift_ideas_select_owned_or_shared` (owner
  / grupa / `visible_to_all` / uczestnik gift planu) — ✅ potwierdzone testem
  "uczestnik planu widzi TEN pomysł, obcy nadal nie".

Jedyna realna usterka z tej tury była po stronie klienta, nie w SQL — patrz
Bug 3 wyżej, sekcja "Poprawka do poprawki".

---

## Czwarta tura — ETAP 5, automatyczne pobieranie metadanych z linku

Kolejny krok z roadmapy `instrukcja.txt` po dokończeniu wątku post-MVP.
Zero zmian w `schema.sql` — to czysto serwerowa funkcja + drobne UI.

Nowy endpoint `src/app/api/fetch-link-metadata/route.ts` (Next.js API route,
`runtime = "nodejs"` — potrzebne dla `node:dns`): przyjmuje `{url}`, waliduje
protokół (tylko http/https) i blokuje oczywiste cele SSRF (localhost,
zakresy prywatne IPv4/IPv6 po `dns.lookup`) zanim w ogóle wyśle request.
Fetchuje z timeoutem 5s i limitem 2MB, przerywając strumień jak tylko trafi
`</head>` (OG-tagi są zawsze w head, nie ma sensu ściągać całej strony).
Parsuje `og:title`/`og:image`/`og:description`/`og:site_name`/
`product:price:amount` (z fallbackami do `<title>`, `twitter:*`, nazwy
hosta) prostymi regexami — bez zależności typu `cheerio`, bo to jedyne, czego
tu trzeba. Błąd/timeout zwraca `{error}` z kodem 200 (nie 4xx/5xx) — zgodnie
z instrukcją "jeśli się nie uda, pokazujemy formularz ręczny", klient po
prostu nic nie robi i zostaje z pustym polami do wypełnienia.

Świadomie NIE broni przed DNS rebindingiem (TOCTOU między sprawdzeniem IP a
właściwym fetchem, który idzie po nazwie hosta, nie po sprawdzonym IP) — to
wymagałoby customowego dispatchera fetch pinującego konkretny adres. Uznane
za nieproporcjonalne do ryzyka tej funkcji (czyta tylko publiczne meta-tagi,
nie robi nic z odpowiedzią poza wyciągnięciem kilku stringów).

Klient (`AddIdeaScreen`): `onBlur` na polu URL (nie `onChange` per-klawisz —
zbyt częste zapytania) odpytuje endpoint i uzupełnia **tylko puste pola**
(nazwa/cena/sklep/komentarz/zdjęcie) — nigdy nie nadpisuje tego, co
użytkownik już wpisał ręcznie. Zdjęcie z metadanych to zwykły zewnętrzny URL
w `imageUrl` (nie przechodzi przez nasz bucket `idea-images` — to zarezerwowane
dla ręcznego uploadu), więc istniejący mechanizm podglądu (`previewUrl =
filePreviewUrl ?? newIdea.imageUrl`) obsłużył to bez żadnej zmiany. Mały
`lastFetchedUrl` ref zapobiega powtórnemu fetchowaniu tego samego URL-a przy
kolejnych blur (np. tab między polami formularza).

Zweryfikowane: `curl` bezpośrednio na endpoint (poprawne parsowanie na
GitHub, poprawne blokady na `localhost`/`127.0.0.1`/`file://`/braku URL-a) +
pełny test UI w Playwright (wklejenie linku → blur → automatyczne
wypełnienie nazwy/zdjęcia/sklepu/opisu, zrzut ekranu potwierdzający).
`tsc`/`lint`/`build` czyste.

## Piąta tura (2026-09-07) — Okazje, Czat, Ankiety ("wszystko poza monetyzacją")

Użytkownik: *"No to wszystko poza monetyzacja. Z tym poczekamy aż skończę
testy na ludziach"* — zbudowano pozostałe trzy etapy z `instrukcja.txt`,
komplementując mapę produktu poza monetyzacją.

**Okazje (etap 8).** Nowa tabela `occasions` (owner_id/name/occasion_date/
group_id), celowo NIE zastępuje wolnotekstowego `profiles.birthday` — obie
sekcje ("Nadchodzące okazje" nowa, "Nadchodzące urodziny" stara) współistnieją
na ekranie Prezenty. Każda okazja liczona jako coroczna (najbliższe
wystąpienie miesiąc+dzień, `daysUntilNextOccurrence`). RLS bez
`SECURITY DEFINER` — to własne urodziny właściciela, nie ma tu niespodzianki
do ochrony.

**Czat (etap 18).** `chat_messages` scoped na `gift_plan_id`, reużywa
`is_gift_plan_participant` z etapu 17 zamiast wynajdywać nowy koncept — z
definicji właściciel pomysłu nie ma dostępu, bo nie jest uczestnikiem planu
dla własnego pomysłu. Jedyna tabela celowo POMINIĘTA w `loadSession`
(ładowana leniwie per otwarty plan) — brak naturalnego sufitu rozmiaru.
Wysyłanie polega na echu z Supabase Realtime, nie na optymistycznym
appendzie.

**Ankiety (etap 19).** `polls`/`poll_options`/`poll_votes` — "Co kupujemy
Kubie?". Jedyne miejsce w schemacie wymagające JAWNEGO wykluczenia
(`auth.uid() <> target_id`), bo target mógłby być normalnym
uczestnikiem/znajomym w innym kontekście — samo pominięcie polityki (wzorzec
z rezerwacji) by tu nie wystarczyło. `poll_options`/`poll_votes` dziedziczą
widoczność przez `exists (select 1 from polls p where p.id = ...)` zamiast
duplikować warunek — odkryty, reużywalny wzorzec RLS (subquery do tabeli
nadrzędnej przechodzi przez JEJ RLS dla bieżącej roli).

**Błędy złapane i naprawione:**
- TS2304 (10x) w `ProfileScreen` — nowe propsy dodane do typu, zapomniane w
  destrukturyzacji. `tsc --noEmit` złapał od razu.
- `react-hooks/set-state-in-effect` w efekcie ładującym czat — `setChatMessages([])`
  w głównym ciele efektu zamiast w cleanup (ten sam wzorzec błędu co
  wcześniej przy oznaczaniu powiadomień jako przeczytane).
- **Znaleziony dopiero w live Playwright, nie w tsc/lint/build**: nowy typ
  powiadomienia `poll_created` dodany do `notifications_type_check` w
  schema.sql, ale zapomniany w `textFor()` (switch renderujący treść
  powiadomienia w `NotificationsScreen`) — cicho padał na domyślne "Nowe
  powiadomienie." zamiast opisowego tekstu. Naprawione dodaniem brakującego
  `case`. Wniosek zapisany do CLAUDE.md: każdy nowy typ w bazie wymaga
  odpowiadającego case w UI, i to dokładnie ten rodzaj błędu, którego same
  testy backendowe (RLS) nie złapią — trzeba go zobaczyć w przeglądarce.

**Testy napisane:** `supabase/tests/occasions-chat-polls.test.mjs` (8 nowych
testów: widoczność okazji z/bez grupy + insert/delete tylko właściciela,
chat_messages tylko dla uczestników planu + zakaz podszywania się, polls
target-exclusion + widoczność przez wspólnych znajomych + group_id scoping,
poll_options tylko twórca dodaje, poll_votes upsert = jeden głos na osobę +
zakaz głosowania w cudzym imieniu). Wszystkie 23 istniejące testy
(gift-lifecycle + post-mvp) nadal przechodzą — zero regresji.

**Weryfikacja UI (Playwright, dwa/trzy równoległe konta demo, prawdziwy
Supabase):** Okazje — dodanie z widocznością "Wszyscy znajomi", licznik "za
7 dni" poprawny, widoczne na ekranie Prezenty znajomego dopiero po
odświeżeniu sesji (zgodne z architekturą: `loadSession` raz na sesję, ta
tabela nie ma Realtime). Czat — zorganizowanie wspólnego prezentu →
zaproszenie kolejnej osoby → powiadomienie → akceptacja → wymiana wiadomości
w obie strony z dostawą przez Realtime bez odświeżania, bąbelki własne/cudze
wizualnie odróżnione, właściciel pomysłu bez dostępu do czatu (0 wierszy).
Ankiety — utworzenie ankiety o koledze → target nie widzi jej ani na liście,
ani pod bezpośrednim URL-em (pusty ekran, zero wycieku) → wspólny znajomy
widzi i głosuje → wynik z poprawnym % i ✓ przy własnym głosie. `tsc --noEmit`
/ `lint` (0 błędów) / `build` (wszystkie 4 nowe trasy zarejestrowane) czyste
po naprawie powyższych błędów.

## Szósta tura (2026-09-07) — pierwsi realni testerzy: klikalne powiadomienia, live realtime, rebranding

Użytkownik zaczął zapraszać pierwsze prawdziwe osoby do testów po wrzuceniu
na Vercel i szybko zgłosił serię błędów w prawdziwym użyciu (nie
wychwyconych przez wcześniejsze testy, bo te zawsze robiły świeże logowanie
per test, maskując prawdziwy problem).

**Diagnoza root cause:** cztery tabele (`idea_suggestions`,
`gift_plan_participants`, `polls`, `poll_votes`) miały włączony Supabase
Realtime po stronie bazy, ale klient nigdy ich nie subskrybował — tylko
`notifications`/`friend_requests` miały odbiorcę zdarzeń. Powiadomienie
przychodziło (bo TO jest zasubskrybowane), ale treść pod spodem (sugestia,
plan, ankieta) czekała do odświeżenia sesji. Stąd "widzę powiadomienie, nic
nie ma".

**Naprawione:**
- Dzwoneczek powiadomień dodany do WSZYSTKICH 4 głównych zakładek (był tylko
  na Pomysły/Ludzie).
- Realtime INSERT/UPDATE dla `idea_suggestions`, `gift_plan_participants`,
  `poll_votes`, plus nowe `polls`/`poll_options`/`gift_plans` dodane do
  publikacji. Kluczowe odkrycie: zaproszenie do wspólnego prezentu wymaga
  DOCIĄGNIĘCIA planu+pomysłu osobnym zapytaniem po odebraniu eventu na
  `gift_plan_participants` — sam insert tego wiersza to pierwszy moment, gdy
  zaproszony w ogóle ma RLS-owe prawo do zobaczenia `gift_plans`/`gift_ideas`,
  więc subskrypcja samych tych tabel nic by nie przechwyciła (event minął,
  zanim uprawnienie istniało). Ankiety inne: znajomy targetu kwalifikuje się
  od razu przy tworzeniu ankiety, więc zwykła subskrypcja `polls` wystarcza.
- Dodano `notifications.gift_plan_id`/`poll_id` (nowe kolumny) + zaktualizowano
  `invite_to_gift_plan`/`notify_poll_created`, żeby powiadomienie niosło
  DOKŁADNY cel nawigacji. Każdy typ powiadomienia w "Wszystkie" ma teraz
  `onClick`: prowadzi do pomysłu/osoby/planu/ankiety albo przełącza zakładkę
  Zaproszenia/Sugestie.
- "Wspólny prezent" pokazuje "Dla: {imię właściciela}" (lista i szczegóły) —
  wcześniej nie było widać, dla kogo w ogóle jest organizowany prezent.
- **Realny incydent podczas migracji:** plik miał DWIE definicje
  `notifications_type_check` (starą, wąską z początku pliku i nową, pełną
  niżej) — ponowne wklejenie całego schema.sql od góry na żywej bazie z
  wierszami typu `poll_created` uderzało w węższą definicję i failowało z
  "check constraint is violated by some row". Usunięta zdublowana, węższa
  definicja — nauka: przy pliku pomyślanym jako "wklej cały, wielokrotnie",
  nie wolno mieć dwóch definicji tego samego constraintu w różnych miejscach,
  nawet jeśli historycznie tak to narosło.
- Rebranding "Widoczek" → "WhishApp" (nazwa robocza, użytkownik uznał starą
  za "durną") we wszystkich user-facing miejscach w kodzie (landing, tytuł
  strony, share dialog) + nagłówki CLAUDE.md/monetyzacja.txt. Celowo
  NIE zmieniono localStorage key `widoczek_pending_invite` — czysto
  techniczny identyfikator, zmiana ryzykowałaby zgubienie zaproszenia w
  trakcie realizacji u kogoś z otwartą kartą, zero korzyści dla użytkownika.

**Weryfikacja (Playwright, prawdziwy Supabase, symulacja "już zalogowany,
bez przeładowania"):** potwierdzono, że zaproszenie do wspólnego prezentu
dociera do już otwartej karty bez odświeżenia, powiadomienie renderuje się
jako klikalny przycisk i prowadzi wprost do właściwego planu z poprawnym
"Dla: X", "Dołączam" działa od razu bez przeładowania, nowa ankieta
pojawia się w czasie rzeczywistym na ekranie powiadomień drugiej,
już zalogowanej osoby. Stare powiadomienia sprzed migracji (bez
`gift_plan_id`/`poll_id`) poprawnie renderują się jako NIEklikalne — brak
fałszywej obietnicy nawigacji tam, gdzie nie ma dokąd. 31/31 testów
backendowych bez regresji, `tsc`/`lint`/`build` czyste.
