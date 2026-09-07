import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

// Usunięcie użytkownika z auth.users wymaga klucza service-role — nigdy nie
// trafia on do przeglądarki, dlatego ta operacja musi żyć po stronie serwera.
// Kaskadowe usunięcie profilu, pomysłów, rezerwacji itd. załatwiają już
// istniejące `on delete cascade` w schema.sql.
export async function POST(request: Request) {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) {
        return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
    }

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
        return NextResponse.json({ error: "Serwer nie jest skonfigurowany." }, { status: 500 });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: userData, error: userError } = await adminClient.auth.getUser(token);
    if (userError || !userData.user) {
        return NextResponse.json({ error: "Nieprawidłowa sesja." }, { status: 401 });
    }

    const { error: deleteError } = await adminClient.auth.admin.deleteUser(userData.user.id);
    if (deleteError) {
        return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
}
