# Supabase setup

1. Utwórz nowy projekt w Supabase.
2. Skopiuj URL i klucze do plików `.env`.
3. Zastosuj schemat: `supabase db push` albo uruchom SQL z [schema.sql](schema.sql).
4. Uruchom skrypt demo:

   ```bash
   cd supabase
   cp .env.example .env
   # uzupełnij klucze
   node create-demo-users.mjs
   ```

5. W projekcie Next.js skopiuj [gift-glimpse-next/.env.example](../gift-glimpse-next/.env.example) do `.env.local` i uzupełnij te same klucze.

Uwaga: hasło dla wszystkich demo-userów to `%TGBnhy6`.
