# Postęp projektu: Gift Glimpse

## Data
2026-09-05

## Status
- Zidentyfikowano, że obecny projekt w [gift-glimpse-io](gift-glimpse-io) jest prototypem Vite/TanStack Router, nie finalnym Next.js.
- Potwierdzono, że brakujące ekrany to: dodawanie pomysłu, ludzie, profil znajomego, prezenty, grupy, profil użytkownika i ustawienia prywatności.
- Przyjęto decyzję: przejść na Next.js, aby łatwiej było potem podłączyć Supabase i Vercel.

## Działania wykonane
- Zrobiono analizę aktualnego projektu oraz sprawdzenie struktury mock-data i routingu.
- Utworzono plan przejścia do Next.js z zachowaniem estetyki i flow prototypu.
- Uruchomiono czysty projekt Next.js w osobnym katalogu [gift-glimpse-next](gift-glimpse-next) bez konfliktów z istniejącym prototypem Vite.
- Przeniesiono spójny układ designu i podstawowe mock data do nowej aplikacji.
- Dodatkowo dodano kluczowe ekrany MVP: home, add idea, detail, people, gifts, groups, profile i privacy.

## Weryfikacja setupu
- Próba uruchomienia `create-next-app` w istniejącym katalogu [gift-glimpse-io](gift-glimpse-io) zakończyła się niepowodzeniem z powodu konfliktu katalogu.
- Decyzja: utworzyć osobny folder Next.js, zachowując obecny prototyp Vite jako źródło designu i reference.
- Wykonano walidację build: `npm run build` w [gift-glimpse-next](gift-glimpse-next) zakończył się sukcesem.

## Dodatkowe dopracowanie flow UI
- Rozszerzono flow prototypu o lepszą obsługę rezerwacji pomysłu z widocznym stanem "zarezerwowane przez Ciebie".
- Dodano bardziej kompletne sekcje profilu użytkownika, grup i prezentów, aby aplikacja miała pełniejsze poczucie produktu.
- Uzupełniono elementy prywatności i działania UI, w tym blok informacyjny o ukrytej rezerwacji i przejścia między ekranami.
- Zaktualizowano style w [gift-glimpse-next/src/app/globals.css](gift-glimpse-next/src/app/globals.css) pod nowe komponenty i lepsze odczucie mobile flow.

## Weryfikacja po rozszerzeniu flow
- Zbudowano ponownie projekt: `npm run build` w [gift-glimpse-next](gift-glimpse-next) zakończył się sukcesem.
- Status: UI flow jest stabilne i gotowe do kolejnego etapu modelowania danych Supabase oraz zabezpieczeń prywatności.

## Korekta po buildu produkcyjnym
- Zidentyfikowano błąd TypeScript w [gift-glimpse-next/src/components/AppShell.tsx](gift-glimpse-next/src/components/AppShell.tsx): zmienna `selectedFriend` była używana przed deklaracją.
- Naprawiono kolejność deklaracji, tak aby stan profilu znajomego był zdefiniowany przed użyciem w memoizowanych widokach listy pomysłów.
- Potwierdzono poprawkę świeżą walidacją: `npm run build` w [gift-glimpse-next](gift-glimpse-next) zakończył się sukcesem, z komunikatem `✓ Compiled successfully` i `✓ Finished TypeScript`.

## Następny krok
- Utrwalić i dopracować brakujące flow UX w nowym projekcie Next.js.
- Przygotować strukturę pod Supabase i Vercel.
- Rozpocząć model danych i security layer dla pomysłów, grup i rezerwacji.

## Konfiguracja Supabase
- Przygotowano schemat bazy [supabase/schema.sql](supabase/schema.sql) z tabelami profili, znajomych, grup, członków grup i pomysłów na prezenty.
- Przygotowano skrypt demo [supabase/create-demo-users.mjs](supabase/create-demo-users.mjs), który tworzy 11 użytkowników z hasłem `%TGBnhy6` i mailami w formacie `jakub.jacek.chmielewski+[1..11]@gmail.com`.
- Każdy użytkownik ma 2-4 pomysły w różnych kategoriach oraz losowo wygenerowane 6 znajomych.
- Przygotowano pliki [supabase/.env.example](supabase/.env.example) i [gift-glimpse-next/.env.example](gift-glimpse-next/.env.example) pod klucze projektu.
- Dodano instrukcję uruchomienia w [supabase/README.md](supabase/README.md).

## Zasady projektowe
- mobile-first
- prywatność jako priorytet
- płynne flow między ekranami
- łatwość migracji do backendu Supabase
- nie budować pełnego backendu na tym etapie
