# WhishApp — kontekst projektu

Nazwa robocza (wcześniej "Widoczek", zmienione 2026-09-07 — jeśli natrafisz na
starą nazwę w komentarzach czy nazwach kluczy technicznych, to celowo
pozostawione ślady historyczne, nie literówka).

Prywatna, społecznościowa aplikacja do zapisywania pomysłów na prezenty przez
cały rok i udostępniania ich wybranym grupom znajomych, żeby mogli po cichu
zarezerwować prezent bez pytania właściciela, co chce dostać.

Pełna wizja produktu i etapy rozwoju: **`instrukcja.txt`** (katalog główny).
Wizja monetyzacji (na później, nie do wdrożenia teraz): **`monetyzacja.txt`**.

Kod: `gift-glimpse-next/` (Next.js 16, App Router, TypeScript, Supabase).
Poprzedni prototyp Vite (`gift-glimpse-io/`, referencja designu z Lovable)
został usunięty 2026-09-07 — nieużywany, bez odwołań z `gift-glimpse-next/`.

## Stan na 2026-09-07

Zbudowane i działające: auth (rejestracja/logowanie/reset hasła/usunięcie
konta), onboarding z opcjonalnym dodaniem pierwszego pomysłu, landing page,
CRUD pomysłów (w tym opcjonalne zdjęcie — upload albo automatyczne
pobranie z linku), **automatyczne pobieranie metadanych z URL** (etap 5 —
`src/app/api/fetch-link-metadata/route.ts`, wypełnia nazwę/zdjęcie/cenę/sklep/
opis z tagów Open Graph, tylko puste pola, cicho failuje do formularza
ręcznego), realne grupy z zapraszaniem członków (też do już istniejącej
grupy), widoczność pomysłów per grupa **oraz "Wszyscy znajomi"** (nie sztywne
tagi), pełny cykl życia pomysłu (Pomysł → Rezerwacja → Kupione → Dostałem ❤️
→ Archiwum) z rezerwacjami ukrytymi przed właścicielem (globalny przełącznik
+ per grupa), system zaproszeń do znajomych (żądanie/akceptacja, nie
natychmiastowe dodanie), prawdziwe powiadomienia z zakładkami i Supabase
Realtime, **"Podrzuć pomysł"** (etap 15) i **"Wspólne prezenty"** (etap 17,
z tym samym niezmiennikiem prywatności co rezerwacje), **"Znajdź prezent"**
(etap 16, czysto kliencki wizard), **"Okazje"** (etap 8 — `occasions`, model
uzupełniający, nie zastępujący, wolnotekstowe pole `birthday`), **Czat**
(etap 18, przypięty do `gift_plan_id` — nie ogólny messenger, dziedziczy
niezmiennik prywatności "Wspólnych prezentów"), **Ankiety** (etap 19 —
"Co kupujemy X?", z jawnym wykluczeniem osoby, dla której planowany jest
prezent), edycja profilu (dane/e-mail/hasło/zdjęcie z domyślnymi
inicjałami), routing z prawdziwymi URL-ami dla każdego widoku.

Nie zbudowane jeszcze (celowo): katalog produktów, cokolwiek z
`monetyzacja.txt` (afiliacja/rekomendacje/reklamy) — **świadomie odłożone,
użytkownik czeka z tym aż skończy testy z prawdziwymi ludźmi.** Poza
monetyzacją całość mapy z `instrukcja.txt` jest zbudowana.

## Architektura — dlaczego tak, nie inaczej

**Cała aplikacja renderuje się w jednym trwałym komponencie klienckim.**
`AppShell` (`src/components/AppShell.tsx`) jest zamontowany raz w
`src/app/layout.tsx` i **nigdy się nie odmontowuje** między nawigacjami —
dzięki temu dane z Supabase (profile, pomysły, znajomości, grupy) są
pobierane raz przy starcie sesji, a nie przy każdym kliknięciu.

Każdy `page.tsx` w `src/app/**` jest **celowo pusty** (`return null`) —
istnieje wyłącznie po to, żeby dany URL był w ogóle routowalny w Next.js.
Cały realny UI czyta stan **bezpośrednio z URL-a** przez `usePathname()` +
funkcję `parseRoute()` w `AppShell.tsx` — nie ma osobnego stanu Reacta
"jaki ekran jest aktywny". To gwarantuje, że odświeżenie strony zawsze
zostawia użytkownika dokładnie tam, gdzie był.

Świadomy koszt tego podejścia: **brak prawdziwego SSR**. Treść nie jest
renderowana na serwerze — to kompromis konieczny, żeby stan przetrwał
nawigację. Próba dodania SSR bez przebudowy całego modelu (Server
Components + przekazywanie danych jako propsy) zepsułaby trwałość stanu.
W dev widoczny był migający wskaźnik Next.js w rogu ekranu przy każdej
nawigacji do trasy dynamicznej (`ƒ`) — wyłączony przez `devIndicators: false`
w `next.config.ts`, nieszkodliwy i tak wyłącznie w `next dev`.

Nawigacja: funkcje `goTo*` w `AppShell.tsx` (np. `goToIdeaDetail`,
`goToPersonProfile`) wołają `router.push`/`router.replace` z gotowym URL-em.
Przyciski "Wróć" wołają `goBack()` (prawdziwa historia przeglądarki, nie
ręcznie śledzony stan powrotu).

## Model danych (Supabase)

Źródło prawdy: `supabase/schema.sql` — **idempotentny**, można go bezpiecznie
wklejać do SQL Editora wielokrotnie (każda `create table`/`create policy`
ma `if not exists`/poprzedzający `drop`). **Po każdej zmianie w tym pliku
trzeba go ręcznie wkleić do Supabase SQL Editora i uruchomić — nikt tego
nie robi automatycznie.**

Tabele:
- `profiles` — jeden wiersz per użytkownik, tworzony automatycznie przy
  pierwszym logowaniu jeśli brakuje (patrz `loadSession` w AppShell).
  `reservations_enabled` (default `true`) to **globalny master-switch**
  rezerwacji na całym koncie, nadrzędny wobec ustawień per grupa — jedyny
  sposób wyłączenia rezerwacji dla pomysłów "Wszyscy znajomi", które nie
  mają żadnej grupy do przełączenia.
- `friendships` — relacja znajomości (kierunkowa w zapisie, odczyt
  dwukierunkowy). Powstaje tylko przez akceptację `friend_requests` albo
  link z `friend_invites` — **nigdy** natychmiast przy samym wyszukaniu
  osoby.
- `friend_requests` — zaproszenie do znajomych oczekujące na akceptację
  (bez osobnej kolumny status — sam fakt istnienia wiersza to "pending";
  akceptacja/odrzucenie usuwa wiersz, patrz `accept_friend_request`).
- `friend_invites` — uniwersalny, wielokrotnego użytku link zapraszający
  (inny mechanizm niż `friend_requests` — do współdzielenia poza appką).
- `idea_groups` + `group_members` — prawdziwe grupy zakładane przez
  użytkowników (zakładka Ludzie → Grupy, z dodawaniem członków do już
  istniejącej grupy). Mają `reservations_enabled` **per grupa**.
- `gift_ideas` — pomysł. Ma `status` (`active`/`archived`, patrz cykl życia
  niżej), `visible_to_all` (trzecia kategoria widoczności obok grup i "tylko
  ja" — **domyślna dla nowego pomysłu**, zmienione po feedbacku pierwszych
  testerów, którzy oczekiwali, że nowy pomysł jest od razu widoczny
  wszystkim, nie tylko właścicielowi), `reservations_enabled` (domyślnie
  `true` — przełącznik rezerwacji **per pomysł**, trzeci poziom obok
  globalnego na `profiles` i per grupa na `idea_groups`; wszystkie trzy
  muszą być spełnione naraz, sprawdzane w RLS `gift_reservations_insert_not_owner`
  i lokalnie w `selectedIdeaOwnerAllowsReservations`), `image_url`
  (opcjonalne zdjęcie — upload do bucketu `idea-images` albo URL z
  automatycznego pobrania metadanych). **Nie ma już kolumny `visibility`**
  (usunięta) ani `reserved_by` (usunięta) — zastąpione przez tabele niżej.
  Kolumna `category` istnieje (nullable) jako zaczątek pod przyszły katalog
  produktów — formularz jej jeszcze nie zbiera.
- `idea_visibility` (idea_id, group_id) — komu pomysł jest udostępniony przez
  konkretną grupę. **Brak wierszy i `visible_to_all=false` = widoczny tylko
  dla właściciela.** To jest mechanizm realnie wymuszający prywatność (patrz
  niżej), nie tylko kosmetyka w UI.
- `gift_reservations` — osobna tabela (nie kolumna na `gift_ideas`), właśnie
  po to, żeby RLS mogło całkowicie odciąć właściciela od odczytu. Ma `status`
  (`reserved`/`purchased`/`cancelled`/`completed`) — pełny cykl życia opisany
  niżej. Częściowy unique index gwarantuje jedną AKTYWNĄ rezerwację na
  pomysł naraz, ale pozwala na ponowną rezerwację po anulowaniu.
- `notifications` — wyłącznie insert przez `SECURITY DEFINER` (triggery albo
  RPC), klient nigdy nie insertuje bezpośrednio. Typy: `gift_received_reserved`,
  `gift_received_purchased_confirmed`, `friend_request_received`,
  `friend_request_accepted`, `idea_suggestion_received`, `gift_plan_invite`,
  `poll_created`. **Każdy nowy typ w `notifications_type_check` (schema.sql)
  musi mieć odpowiadający `case` w `textFor()` w `NotificationsScreen`
  (AppShell.tsx)** — inaczej cicho pada na domyślne "Nowe powiadomienie."
  (dokładnie to się stało z `poll_created` przy pierwszym wdrożeniu ankiet,
  złapane dopiero w live Playwright, nie w tsc/lint). Włączony Supabase
  Realtime (`supabase_realtime` publication).
- `idea_suggestions` — "Podrzuć pomysł" (etap 15): sender/recipient/title/
  url/image_url/status. Prostsze niż rezerwacje (brak niespodzianki do
  ochrony), więc zwykłe RLS bez `SECURITY DEFINER` na zapis.
- `gift_plans` + `gift_plan_participants` — "Wspólne prezenty" (etap 17).
  **Zero polityk INSERT/UPDATE dla klienta** — wszystko przez
  `create_gift_plan`/`invite_to_gift_plan`/`respond_to_gift_plan_invite`
  (patrz niżej).
- `occasions` (etap 8) — owner_id/name/occasion_date/group_id. Uzupełnia,
  nie zastępuje `profiles.birthday`. Każda okazja traktowana jako coroczna
  (liczy się najbliższe wystąpienie miesiąca+dnia, patrz
  `daysUntilNextOccurrence` w AppShell) — brak tu niespodzianki do ochrony
  (to własne urodziny właściciela), więc zwykłe RLS bez `SECURITY DEFINER`:
  widoczne właścicielowi zawsze, znajomym jeśli bez `group_id` albo jeśli
  należą do wskazanej grupy.
- `chat_messages` — Czat (etap 18), scoped na `gift_plan_id`, reużywa
  `is_gift_plan_participant` z etapu 17 zamiast wynajdywać nowy koncept
  "konwersacji" — dzięki temu właściciel pomysłu z definicji nie ma dostępu
  (nie jest uczestnikiem planu dla własnego pomysłu). Bez UPDATE/DELETE
  (wiadomości niezmienne, świadome uproszczenie). Jedyna tabela w schemacie
  celowo pominięta w `loadSession` — ładowana leniwie tylko gdy otwarty
  konkretny plan (brak naturalnego sufitu rozmiaru jak przy resztcie tabel).
  Wysyłający polega na echu z Realtime, nie na optymistycznym appendzie —
  prostsze, bez klasy błędów "duplikat wiadomości".
- `polls` + `poll_options` + `poll_votes` — Ankiety (etap 19). Jedyne
  miejsce w schemacie, gdzie wykluczenie osoby wymaga **jawnego warunku**
  (`auth.uid() <> target_id` w polityce SELECT na `polls`), nie tylko braku
  polityki — bo `target_id` (osoba, dla której planowany jest prezent) może
  być normalnym uczestnikiem/znajomym w innym kontekście, więc "brak
  dostępu przez pominięcie" by tu nie wystarczył. `poll_options`/`poll_votes`
  nie duplikują warunku widoczności — ich polityki robią
  `exists (select 1 from polls p where p.id = ...)`, co automatycznie
  dziedziczy RLS `polls` dla bieżącej roli (reużywalny wzorzec: subquery do
  tabeli nadrzędnej przechodzi przez JEJ politykę). Głos to `poll_votes`
  upsert z `onConflict: "poll_id,user_id"` (jeden głos na osobę, zmiana
  zdania nadpisuje). `notify_poll_created` (trigger) powiadamia wspólnych
  znajomych targetu poza nim samym i twórcą, z uwzględnieniem `group_id`.
- Supabase Storage buckety `avatars` i `idea-images` (public, zapis tylko we
  własnym folderze `<user_id>/...`; SELECT ograniczony do własnego folderu —
  **wymagane dla `{upsert: true}`**, patrz "Do zapamiętania" niżej). Przed
  każdym uploadem (`compressImageFile` w AppShell.tsx) zdjęcie jest
  przeskalowane (maks. 1600px dłuższy bok) i skonwertowane do WebP przez
  natywne `createImageBitmap`/`canvas.toBlob` (bez zależności) — telefonowe
  zdjęcie 4 MB spada zwykle do ok. 0,5 MB. GIF-y pomijane (utrata animacji);
  błąd konwersji cicho zwraca oryginalny plik.

### Zasady prywatności wymuszone w RLS, nie w UI

Dwie rzeczy, które kiedyś (w tym projekcie) były złamane i zostały
naprawione — ważne, żeby nie cofnąć tej pracy przy przyszłych zmianach:

1. **Widoczność pomysłów.** Polityka SELECT na `gift_ideas` pozwala
   zobaczyć wiersz tylko właścicielowi ALBO komuś, kto należy do grupy, z
   którą pomysł jest współdzielony (join przez `idea_visibility` →
   `group_members`). Wcześniej (przez większość historii tego projektu)
   każdy zalogowany widział WSZYSTKIE pomysły wszystkich — to była
   realna luka, nie tylko brak UI.
2. **Ukrycie rezerwacji przed właścicielem.** `gift_reservations` nie ma
   żadnej polityki SELECT dla właściciela pomysłu — fizycznie nie da się
   tego odczytać z klienta, nawet gdyby ktoś próbował ominąć UI. Do
   sprawdzania statusu rezerwacji służą wyłącznie funkcje
   `SECURITY DEFINER`: `is_idea_reserved`/`is_idea_reserved_by_me` — dla
   właściciela zawsze zwracają `false`.

Rezerwacja jest dozwolona tylko jeśli: globalny przełącznik właściciela
(`profiles.reservations_enabled`) jest włączony, ORAZ pomysł jest widoczny
przez grupę z `reservations_enabled = true` albo przez `visible_to_all`
(tam nie ma grupy do sprawdzenia — liczy się tylko globalny przełącznik) —
wszystko sprawdzane w RLS przy insertowaniu rezerwacji, nie tylko w UI.

### Cykl życia pomysłu i rezerwacji (Pomysł → Rezerwacja → Kupione → Dostałem → Archiwum)

`gift_ideas.status` (`active`/`archived`) i `gift_reservations.status`
(`reserved`/`purchased`/`cancelled`/`completed`) są **celowo rozdzielone** —
to dwa niezależne stany, nie jeden połączony enum. Cała logika przejść żyje
w jednej funkcji `SECURITY DEFINER`, `mark_idea_received(idea_id,
confirm_purchaser?)`, wywoływanej gdy właściciel klika "❤️ Dostałem":
- jeśli pomysł miał rezerwację `purchased` i `confirm_purchaser` jest
  `null` → zwraca `needs_confirmation: true` i **nic nie zmienia**, żeby
  klient dopiero zapytał właściciela "czy to ten prezent?" — to jedyny
  moment, gdy jakakolwiek informacja o rezerwacji dociera do właściciela, i
  to tylko w formie "ktoś to kupił", nigdy "kto".
- w przeciwnym razie archiwizuje pomysł i zamyka rezerwację, wysyłając
  najwyżej jedno neutralne powiadomienie do rezerwującego (nigdy do
  właściciela).

Transition trigger (`enforce_reservation_transition`) pilnuje, że klient
przez zwykły UPDATE może osiągnąć tylko `reserved→purchased→cancelled` —
status `completed` da się ustawić wyłącznie wewnętrznie przez
`mark_idea_received` (przez `set_config('app.internal_reservation_update', ...)`
jako furtkę rozpoznawaną w triggerze).

**Limit aktywnych rezerwacji** (1 dla 1–4 widocznych pomysłów danej osoby,
3 dla 5+) jest egzekwowany triggerem `enforce_reservation_limit` na
`gift_reservations`, z `pg_advisory_xact_lock` przeciwko race conditions
(dwa równoczesne inserty tej samej pary rezerwujący/właściciel).

**"Wspólne prezenty"** (`gift_plans`/`gift_plan_participants`) mają dokładnie
ten sam niezmiennik co rezerwacje: właściciel pomysłu nigdy nie może być ani
twórcą, ani uczestnikiem planu dla WŁASNEGO pomysłu, i nie ma żadnej
polityki SELECT na te tabele dla niego. Cały zapis idzie przez
`create_gift_plan`/`invite_to_gift_plan`/`respond_to_gift_plan_invite`
(`SECURITY DEFINER`) — brak jakiejkolwiek polityki INSERT/UPDATE dla
zwykłego klienta, żeby ten niezmiennik pilnować w jednym miejscu, nie w
kilku rozjechanych politykach RLS. Uczestnik planu widzi TEN JEDEN pomysł
nawet bez normalnej widoczności (grupa/`visible_to_all`) — przez czwarty
warunek OR w `gift_ideas_select_owned_or_shared`
(`idea_shared_via_gift_plan`), celowo zawężony do tego pomysłu, nie do
reszty pomysłów właściciela.

### Serwerowe API route'y (`src/app/api/`)

- `delete-account/route.ts` — jedyne miejsce używające
  `SUPABASE_SERVICE_ROLE_KEY` (nigdy w kodzie klienckim/`NEXT_PUBLIC_*`).
  Usuwa użytkownika z `auth.users`, co kaskadowo (przez `on delete cascade`
  w schemacie) czyści profil, pomysły, rezerwacje, członkostwa w grupach.
- `fetch-link-metadata/route.ts` — etap 5, pobiera OG-tagi (nazwa/zdjęcie/
  cena/sklep/opis) z linku wklejonego w formularzu pomysłu. Musi być
  server-side (CORS + bezpieczeństwo — klient nie powinien móc odpytywać
  dowolnych serwerów w cudzym imieniu). Ma podstawową ochronę przed SSRF
  (blokuje `localhost`/prywatne zakresy IP po `dns.lookup`) — **nie broni
  przed DNS rebindingiem** (TOCTOU między sprawdzeniem a fetchem), uznane za
  wystarczające przy obecnym, niskim profilu ryzyka tej funkcji. Timeout
  5s, limit 2MB odczytu, przerywa strumień przy `</head>`. Błąd/timeout =
  zwraca `{error: ...}` z kodem 200, nie 4xx/5xx — klient po prostu zostaje
  z pustym formularzem ręcznym (zgodnie z instrukcją: "jeśli się nie uda,
  pokazujemy formularz ręczny").

## Rzeczy, które wyglądały na gotowe, a były fasadą (uważaj na wzorzec)

Powtarzający się problem w tym projekcie: ładny UI z Lovable bez logiki pod
spodem. Znalezione i naprawione:
- Zakładka Ludzie renderowała mockowe dane zamiast prawdziwych znajomych
  (osobny, nigdy niesynchronizowany stan `personList`).
- Przyciski "Zaproś"/"Pokaż członków" w grupach nie miały `onClick`.
- Przełącznik "Rezerwacje pomysłów" zmieniał tylko własny napis, nic nie
  blokował.
- Przycisk "Usuń konto" nic nie robił.
- Liczniki (np. "4 pomysłów" przy 2 widocznych) pokazywały złą wartość —
  licznik sekcji pokazywał `ideas.length` (total) zamiast liczby kart
  faktycznie renderowanych w tej sekcji.
- Odmiana polskich liczebników była na sztywno "pomysłów" niezależnie od
  liczby — helper `polishPlural`/`ideaWord`/`personWord` w `AppShell.tsx`
  naprawia to wszędzie.

**Jeśli coś w UI wygląda klikalnie, zawsze sprawdź czy faktycznie coś robi
i czy dane są realne (Supabase), zanim uznasz zadanie za skończone.**

## Jak testować zmiany

Nie ma zainstalowanego Playwrighta w projekcie — instalowany doraźnie w
scratchpadzie sesji (`npm install playwright` w katalogu scratchpad, nie w
repo) i używany do e2e-testów w headless Chromium. Dane demo: konta
`jakub.jacek.chmielewski+1@gmail.com` … `+11@gmail.com`, hasło `%TGBnhy6`
(patrz `supabase/create-demo-users.mjs`, `supabase/README.md`).

**Testy backendowe w repo** (`supabase/tests/`) — zwykłe skrypty Node z
`node:assert/strict`, nie framework testowy (brak jest/vitest w projekcie
celowo). Uderzają bezpośrednio w prawdziwy projekt Supabase przez
`@supabase/supabase-js` (service-role do setupu/sprzątania testowych
kont, osobne zalogowane klienty per użytkownik do sprawdzania RLS tak, jak
widzi je aplikacja). Wymagają `supabase/.env` (`SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) i lokalnego
`package.json`/`node_modules` w `supabase/` (osobne od `gift-glimpse-next/`).
Uruchomienie: `cd supabase && node tests/gift-lifecycle.test.mjs && node
tests/post-mvp.test.mjs && node tests/occasions-chat-polls.test.mjs`.
**Po każdej zmianie w `schema.sql` dotyczącej rezerwacji/widoczności/
social-features uruchom wszystkie trzy pliki** — łapią regresje w RLS,
których `tsc`/lint nie widzą.

Standardowa sekwencja weryfikacji przed uznaniem zmiany za gotową:
`npx tsc --noEmit` → `npm run lint` → `npm run build` → testy w
`supabase/tests/` jeśli zmiana dotyczy `schema.sql` → ręczny test w
przeglądarce (dev server + Playwright) jeśli zmiana dotyka realnego flow
użytkownika, nie tylko typów.

## Komendy

W `gift-glimpse-next/`:
- `npm run dev` — serwer deweloperski (trzeba go ręcznie uruchomić i
  zostawić działający terminal; zamknięcie terminala/Ctrl+C go zabija).
- `npm run build` / `npm run lint` / `npx tsc --noEmit`.

## Do zapamiętania na przyszłość

- Grupy realne (`idea_groups`) i widoczność pomysłów są już połączone
  (naprawione dawno temu w tym projekcie) — ale jeśli kiedyś wróci pomysł na
  "sztywne 4 grupy" (Rodzina/Znajomi/Padel/Tylko ja) z wcześniejszych wersji
  Lovable, **nie przywracać** — to był dokładnie ten sam wzorzec fasady.
- `.env.example` musi mieć placeholdery, nigdy prawdziwe klucze — był z
  tym incydent (prawdziwy `SUPABASE_SERVICE_ROLE_KEY` siedział w pliku
  "przykładowym").
- **Publiczny bucket Storage + `{upsert: true}` wymaga polityki SELECT**
  ograniczonej do własnego folderu — bez niej upsert dostaje 403, bo
  Supabase musi sprawdzić, czy plik już istnieje, a bez ŻADNEJ polityki
  SELECT ta wewnętrzna kontrola failuje nawet dla świeżego pliku. Był z tym
  realny incydent po tym, jak usunęliśmy szerszą politykę SELECT z powodu
  ostrzeżenia lintera Supabase o możliwości wylistowania całego bucketu —
  poprawka: węższa polityka SELECT (tylko własny folder), nie brak polityki.
- **Next.js App Router nie wykrywa nawigacji, gdy `pathname` się nie
  zmienia** — nawet jeśli faktyczny indeks w historii przeglądarki się
  przesunął. Jeśli dwa kolejne wpisy historii mają identyczny URL (np. przez
  `router.push` do podekranu i potem `router.replace` z powrotem na ten sam
  URL co wpis SPRZED push), pierwsze kliknięcie "Wróć"/`router.back()`
  wizualnie nic nie robi. Zasada na przyszłość: ekran, do którego można
  wejść i wrócić do TEGO SAMEGO URL-a (edycja, formularz nadpisujący),
  powinien wchodzić przez `router.replace`, nie `push` — wtedy nie ma się
  co zdublować.
- Architektura tego projektu (persistent client shell, `loadSession` raz na
  sesję) oznacza, że dane innego użytkownika (np. ktoś dodał Cię do grupy,
  wysłał zaproszenie) nie pojawią się bez odświeżenia/relogowania, **chyba
  że jest to jawnie objęte Supabase Realtime** (patrz `notifications-${userId}`
  channel w AppShell — subskrybuje teraz notifications/friend_requests/
  idea_suggestions/gift_plan_participants/polls/poll_options/poll_votes) —
  pamiętaj o tym ograniczeniu przy każdej nowej funkcji społecznościowej i
  DODAJ subskrypcję od razu, zamiast czekać, aż ktoś zgłosi "widzę
  powiadomienie, ale treść jest pusta" (dokładnie tak wyszła ta luka na
  jaw — zgłoszona przez pierwszych realnych testerów). Wyjątek wymagający
  ręcznego dociągnięcia zamiast samej subskrypcji: `gift_plan_participants`
  — zaproszony dostaje RLS-owe prawo do `gift_plans`/`gift_ideas` DOPIERO w
  momencie tego inserta, więc subskrypcja samych tamtych dwóch tabel
  niczego by nie złapała (event uprawniający je poprzedza).
- **Link z potwierdzeniem e-maila (rejestracja) otwiera się często w innym
  kontekście przeglądarki** (inna karta, aplikacja pocztowa) niż ten, w
  którym ktoś się rejestrował — `localStorage` NIE przechodzi między takimi
  kontekstami. Realny incydent: zaproszenie do znajomych zapisywane w
  localStorage (`widoczek_pending_invite`) przed rejestracją ginęło właśnie
  w ten sposób — użytkownik klikał link z maila, kończył rejestrację, ale
  nigdy nie stawał się znajomym zapraszającego. Naprawione dwutorowo: (1)
  `onRegister` ustawia `emailRedirectTo` z powrotem na `/invite/{code}`, więc
  kod przetrwa w samym URL-u, nie tylko w localStorage — **wymaga, żeby ten
  wzorzec URL-a był dodany do Redirect URLs w Supabase Auth (Dashboard →
  Authentication → URL Configuration), inaczej Supabase go zignoruje i
  wróci do gołego Site URL**; (2) `loadSession` przy odzyskiwaniu
  zaproszenia preferuje kod z aktualnego URL-a (`routeInviteCode`) nad
  localStorage — działa niezależnie od tego, czy to ten sam kontekst
  przeglądarki, czy inny. Zweryfikowane w Playwright: sesja pojawiająca się
  na `/invite/{code}` w kontekście z całkowicie pustym localStorage nadal
  poprawnie tworzy znajomość.
- **Nigdy nie zostawiaj fallbacku do danych z `mock-data.ts` w ścieżce
  wyświetlającej dane PRAWDZIWEGO zalogowanego użytkownika** — realny
  incydent: `effectiveMe.birthday`/`city` miały `profile.birthday ??
  mockMe.birthday` (fallback na wpisaną na sztywno "12 marca 1994" z
  oryginalnego prototypu Lovable), więc każdy nowo zarejestrowany user, który
  nie wypełnił jeszcze urodzin, widział cudzą, przypadkowo wyglądającą datę
  zamiast pustego pola. `mockMe`/`mock-data.ts` wolno używać wyłącznie jako
  placeholder dla stanu "jeszcze niezalogowany" (ekran przed sesją) — nigdy
  jako fallback dla brakującego pola realnego profilu; tam właściwy fallback
  to `null`/`""`, nie żaden mock.
- **Powiadomienia to jeden wspólny moduł, nie osobny ekran per zakładka.**
  Był kiedyś osobny `FriendRequestsScreen`/`/people/requests` dostępny tylko
  z dzwoneczka na zakładce Ludzie, podczas gdy dzwoneczek na Pomysły
  prowadził do pełnego `NotificationsScreen` (`/notifications`) z trzema
  zakładkami (Wszystkie/Zaproszenia/Sugestie) — dwa równoległe, niespójne
  wejścia do tej samej informacji, zgłoszone przez testerów jako mylące.
  Usunięty: dzwoneczek na Ludzie woła teraz `goToFriendRequests()`, które
  ustawia `notificationsTab("zaproszenia")` i nawiguje do TEGO SAMEGO
  `/notifications`. Zasada na przyszłość: jeśli dwa miejsca w UI pokazują tę
  samą kategorię danych, powinny renderować ten sam komponent/ekran (różniąc
  się co najwyżej domyślną zakładką), nie dwie osobne implementacje.
- **Feedback po akcji (np. "Zapisano zmiany.") musi być widoczny bez
  przewijania.** Realny incydent: `EditProfileScreen` ustawiał `profileInfo`
  poprawnie po zapisie danych, ale renderował go jednym wspólnym banerem na
  samym DOLE długiego, wielosekcyjnego formularza (dane/e-mail/hasło) —
  użytkownik klikający "Zapisz dane" blisko góry nigdy nie widział
  potwierdzenia bez ręcznego przewinięcia, więc zapis "wyglądał" jakby nic
  nie robił, mimo że działał poprawnie. Naprawione dodaniem tego samego
  banera od razu pod przyciskiem "Zapisz dane". Zasada: bannery
  sukcesu/błędu muszą siedzieć obok akcji, która je wywołała, nie w jednym
  zbiorczym miejscu na końcu długiego ekranu.
