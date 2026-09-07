// Testy cyklu życia pomysłu/rezerwacji (rezerwacja -> kupione -> dostałem ->
// archiwum) uruchamiane wprost na żywym projekcie Supabase — projekt nie ma
// lokalnego Postgresa ani frameworka testowego, więc trzymamy się konwencji
// już ustalonej w tym repo (patrz create-demo-users.mjs): zwykły skrypt Node
// z node:assert, service-role do setupu/sprzątania, osobne zalogowane
// klienty per użytkownik do sprawdzania RLS tak, jak widzi je aplikacja.
//
// Uruchomienie: node supabase/tests/gift-lifecycle.test.mjs
// Wymaga supabase/.env z SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, "..", ".env");

if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        if (!line || line.trim().startsWith("#")) continue;
        const i = line.indexOf("=");
        if (i === -1) continue;
        const key = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
        if (!process.env[key]) process.env[key] = value;
    }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error("Ustaw SUPABASE_URL, SUPABASE_ANON_KEY i SUPABASE_SERVICE_ROLE_KEY w supabase/.env");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const PASSWORD = "TestPass123!";
const STAMP = Date.now();
const createdUserIds = [];
const createdGroupIds = [];

async function createUser(label) {
    const email = `lifecycle-test+${label}-${STAMP}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error) throw error;
    const { error: profileError } = await admin.from("profiles").insert({ id: data.user.id, email, full_name: label });
    if (profileError) throw profileError;
    createdUserIds.push(data.user.id);

    const client = createClient(SUPABASE_URL, ANON_KEY);
    const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (signInError) throw signInError;
    return { id: data.user.id, email, client };
}

// Grupa + membership + shared idea_visibility odtwarza dokładnie to, co robi
// UI: idea jest "widoczna" dla kogoś wtedy i tylko wtedy, gdy jest w grupie,
// do której viewer należy.
async function makeSharedGroup(ownerId, memberIds) {
    const { data: group, error } = await admin.from("idea_groups").insert({ owner_id: ownerId, name: `Test ${STAMP}` }).select().single();
    if (error) throw error;
    createdGroupIds.push(group.id);
    if (memberIds.length > 0) {
        const { error: memberError } = await admin
            .from("group_members")
            .insert(memberIds.map((userId) => ({ group_id: group.id, user_id: userId })));
        if (memberError) throw memberError;
    }
    return group.id;
}

async function makeIdea(ownerId, groupId, title = "Pomysł") {
    const { data: idea, error } = await admin
        .from("gift_ideas")
        .insert({ user_id: ownerId, title, priority: "chce" })
        .select()
        .single();
    if (error) throw error;
    if (groupId) {
        const { error: visError } = await admin.from("idea_visibility").insert({ idea_id: idea.id, group_id: groupId });
        if (visError) throw visError;
    }
    return idea.id;
}

async function reserve(buyerClient, ideaId) {
    return buyerClient.from("gift_reservations").insert({ idea_id: ideaId, reserved_by: (await buyerClient.auth.getUser()).data.user.id });
}

let passed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`ok - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

async function cleanup() {
    for (const groupId of createdGroupIds) {
        await admin.from("idea_groups").delete().eq("id", groupId);
    }
    for (const userId of createdUserIds) {
        await admin.auth.admin.deleteUser(userId);
    }
}

async function main() {
    const owner = await createUser("owner");
    const buyerA = await createUser("buyera");
    const buyerB = await createUser("buyerb");

    // ---- LIMITY ----

    await test("1 widoczny pomysł -> max 1 rezerwacja", async () => {
        const group = await makeSharedGroup(owner.id, [buyerA.id]);
        const idea1 = await makeIdea(owner.id, group, "Idea 1/1");
        const { error } = await reserve(buyerA.client, idea1);
        assert.equal(error, null);

        const idea2 = await makeIdea(owner.id, group, "Idea 2/1 (no slot)");
        const { error: secondError } = await reserve(buyerA.client, idea2);
        assert.ok(secondError, "druga rezerwacja powinna zostać odrzucona");
        assert.match(secondError.message, /RESERVATION_LIMIT_REACHED/);
    });

    await test("4 widoczne pomysły -> max 1 rezerwacja", async () => {
        const buyer = await createUser("buyer4");
        const group = await makeSharedGroup(owner.id, [buyer.id]);
        const ideas = [];
        for (let i = 0; i < 4; i += 1) ideas.push(await makeIdea(owner.id, group, `4-idea-${i}`));

        const { error: firstError } = await reserve(buyer.client, ideas[0]);
        assert.equal(firstError, null);
        const { error: secondError } = await reserve(buyer.client, ideas[1]);
        assert.ok(secondError);
        assert.match(secondError.message, /RESERVATION_LIMIT_REACHED/);
    });

    await test("5 widocznych pomysłów -> max 3 rezerwacje", async () => {
        const buyer = await createUser("buyer5");
        const group = await makeSharedGroup(owner.id, [buyer.id]);
        const ideas = [];
        for (let i = 0; i < 5; i += 1) ideas.push(await makeIdea(owner.id, group, `5-idea-${i}`));

        for (let i = 0; i < 3; i += 1) {
            const { error } = await reserve(buyer.client, ideas[i]);
            assert.equal(error, null, `rezerwacja ${i} powinna się udać`);
        }
        const { error: fourthError } = await reserve(buyer.client, ideas[3]);
        assert.ok(fourthError, "czwarta rezerwacja powinna zostać odrzucona przy limicie 3");
        assert.match(fourthError.message, /RESERVATION_LIMIT_REACHED/);
    });

    await test("10 widocznych pomysłów -> max 3 rezerwacje", async () => {
        const buyer = await createUser("buyer10");
        const group = await makeSharedGroup(owner.id, [buyer.id]);
        const ideas = [];
        for (let i = 0; i < 10; i += 1) ideas.push(await makeIdea(owner.id, group, `10-idea-${i}`));

        for (let i = 0; i < 3; i += 1) {
            const { error } = await reserve(buyer.client, ideas[i]);
            assert.equal(error, null);
        }
        const { error: fourthError } = await reserve(buyer.client, ideas[3]);
        assert.ok(fourthError);
        assert.match(fourthError.message, /RESERVATION_LIMIT_REACHED/);
    });

    await test("anulowanie rezerwacji zwalnia limit", async () => {
        const buyer = await createUser("buyercancel");
        const group = await makeSharedGroup(owner.id, [buyer.id]);
        const idea1 = await makeIdea(owner.id, group, "cancel-1");
        const idea2 = await makeIdea(owner.id, group, "cancel-2");

        const { data: reservation, error } = await buyer.client
            .from("gift_reservations")
            .insert({ idea_id: idea1, reserved_by: buyer.id })
            .select()
            .single();
        assert.equal(error, null);

        const { error: blockedError } = await reserve(buyer.client, idea2);
        assert.ok(blockedError, "limit powinien blokować drugą rezerwację");

        const { error: cancelError } = await buyer.client
            .from("gift_reservations")
            .update({ status: "cancelled" })
            .eq("id", reservation.id);
        assert.equal(cancelError, null);

        const { error: afterCancelError } = await reserve(buyer.client, idea2);
        assert.equal(afterCancelError, null, "po anulowaniu limit powinien się zwolnić");
    });

    await test("niewidoczne (prywatne) pomysły nie zwiększają limitu", async () => {
        const buyer = await createUser("buyerprivate");
        const group = await makeSharedGroup(owner.id, [buyer.id]);
        // 4 pomysły widoczne (limit=1) + 10 prywatnych (bez idea_visibility, buyer ich nie widzi)
        const visibleIdea = await makeIdea(owner.id, group, "visible-1");
        for (let i = 0; i < 10; i += 1) await makeIdea(owner.id, null, `private-${i}`);

        const { error } = await reserve(buyer.client, visibleIdea);
        assert.equal(error, null);
        const secondVisible = await makeIdea(owner.id, group, "visible-2");
        const { error: secondError } = await reserve(buyer.client, secondVisible);
        assert.ok(secondError, "10 prywatnych pomysłów nie powinno podnieść limitu z 1 do 3");
        assert.match(secondError.message, /RESERVATION_LIMIT_REACHED/);
    });

    // ---- REZERWACJE ----

    await test("nie można ominąć limitu przez bezpośrednie wywołanie API (insert)", async () => {
        // "reserve()" to już jest bezpośrednie wywołanie tabeli przez klienta —
        // nie ma żadnej dodatkowej warstwy w aplikacji do ominięcia. Trigger w
        // bazie egzekwuje limit niezależnie od tego, kto/co wysyła insert.
        const buyer = await createUser("buyerapi");
        const group = await makeSharedGroup(owner.id, [buyer.id]);
        const idea1 = await makeIdea(owner.id, group, "api-1");
        const idea2 = await makeIdea(owner.id, group, "api-2");
        await reserve(buyer.client, idea1);
        const { error } = await reserve(buyer.client, idea2);
        assert.ok(error);
        assert.match(error.message, /RESERVATION_LIMIT_REACHED/);
    });

    await test("race condition: dwa równoczesne inserty nie przekraczają limitu", async () => {
        const buyer = await createUser("buyerrace");
        const group = await makeSharedGroup(owner.id, [buyer.id]);
        const idea1 = await makeIdea(owner.id, group, "race-1");
        const idea2 = await makeIdea(owner.id, group, "race-2");

        const results = await Promise.all([reserve(buyer.client, idea1), reserve(buyer.client, idea2)]);
        const succeeded = results.filter((r) => !r.error);
        const failed = results.filter((r) => r.error);
        assert.equal(succeeded.length, 1, "dokładnie jedna z dwóch równoczesnych rezerwacji powinna przejść");
        assert.equal(failed.length, 1);
        assert.match(failed[0].error.message, /RESERVATION_LIMIT_REACHED/);
    });

    await test("właściciel nie widzi żadnej informacji o rezerwacji", async () => {
        const buyer = await createUser("buyerprivacy");
        const group = await makeSharedGroup(owner.id, [buyer.id]);
        const idea = await makeIdea(owner.id, group, "privacy-1");
        await reserve(buyer.client, idea);

        const { data, error } = await owner.client.from("gift_reservations").select("*").eq("idea_id", idea);
        assert.equal(error, null);
        assert.equal(data.length, 0, "właściciel nie ma polityki SELECT na gift_reservations");
    });

    // ---- KUPIONE ----

    await test("reserved -> purchased działa i jest widoczne tylko kupującemu", async () => {
        const buyer = await createUser("buyerpurchase");
        const group = await makeSharedGroup(owner.id, [buyer.id]);
        const idea = await makeIdea(owner.id, group, "purchase-1");
        const { data: reservation } = await reserve(buyer.client, idea).then((r) => ({ data: r.data }));
        const { data: created } = await buyer.client.from("gift_reservations").select().eq("idea_id", idea).single();

        const { error: updateError } = await buyer.client
            .from("gift_reservations")
            .update({ status: "purchased" })
            .eq("id", created.id);
        assert.equal(updateError, null);

        const { data: mine } = await buyer.client.from("gift_reservations").select("status").eq("id", created.id).single();
        assert.equal(mine.status, "purchased");

        const { data: ownerView } = await owner.client.from("gift_reservations").select("*").eq("idea_id", idea);
        assert.equal(ownerView.length, 0, "właściciel nadal nie widzi statusu purchased");
        void reservation;
    });

    // ---- DOSTAŁEM ----

    await test("właściciel może oznaczyć własny pomysł jako otrzymany, trafia do archiwum", async () => {
        const idea = await makeIdea(owner.id, null, "received-1");
        const { data, error } = await owner.client.rpc("mark_idea_received", { p_idea_id: idea }).single();
        assert.equal(error, null);
        assert.equal(data.needs_confirmation, false);

        const { data: ideaRow } = await admin.from("gift_ideas").select("status").eq("id", idea).single();
        assert.equal(ideaRow.status, "archived");
    });

    await test("nie można ponownie zarezerwować otrzymanego (zarchiwizowanego) pomysłu", async () => {
        const buyer = await createUser("buyerarchived");
        const group = await makeSharedGroup(owner.id, [buyer.id]);
        const idea = await makeIdea(owner.id, group, "archived-1");
        await owner.client.rpc("mark_idea_received", { p_idea_id: idea });

        const { error } = await reserve(buyer.client, idea);
        assert.ok(error, "zarchiwizowany pomysł nie powinien być rezerwowalny");
    });

    await test("nie-właściciel nie może wywołać mark_idea_received na cudzym pomyśle", async () => {
        const idea = await makeIdea(owner.id, null, "not-owner-1");
        const { error } = await buyerA.client.rpc("mark_idea_received", { p_idea_id: idea });
        assert.ok(error);
        assert.match(error.message, /NOT_IDEA_OWNER/);
    });

    // ---- POWIADOMIENIA ----

    await test("reserved + Dostałem -> rezerwujący dostaje powiadomienie, właściciel żadnego", async () => {
        const buyer = await createUser("notifyreserved");
        const group = await makeSharedGroup(owner.id, [buyer.id]);
        const idea = await makeIdea(owner.id, group, "notify-reserved-1");
        await reserve(buyer.client, idea);

        await owner.client.rpc("mark_idea_received", { p_idea_id: idea });

        const { data: buyerNotifications } = await buyer.client
            .from("notifications")
            .select("*")
            .eq("idea_id", idea);
        assert.equal(buyerNotifications.length, 1);
        assert.equal(buyerNotifications[0].type, "gift_received_reserved");

        const { data: ownerNotifications } = await owner.client.from("notifications").select("*").eq("idea_id", idea);
        assert.equal(ownerNotifications.length, 0, "właściciel nigdy nie dostaje powiadomienia ujawniającego rezerwację");
    });

    await test("purchased + Dostałem -> pytanie o potwierdzenie, Tak -> pozytywne powiadomienie kupującego", async () => {
        const buyer = await createUser("notifyyes");
        const group = await makeSharedGroup(owner.id, [buyer.id]);
        const idea = await makeIdea(owner.id, group, "notify-yes-1");
        await reserve(buyer.client, idea);
        const { data: created } = await buyer.client.from("gift_reservations").select().eq("idea_id", idea).single();
        await buyer.client.from("gift_reservations").update({ status: "purchased" }).eq("id", created.id);

        const { data: firstCall } = await owner.client.rpc("mark_idea_received", { p_idea_id: idea }).single();
        assert.equal(firstCall.needs_confirmation, true);

        const { data: ideaAfterFirstCall } = await admin.from("gift_ideas").select("status").eq("id", idea).single();
        assert.equal(ideaAfterFirstCall.status, "active", "przed potwierdzeniem pomysł nie powinien się jeszcze archiwizować");

        await owner.client.rpc("mark_idea_received", { p_idea_id: idea, p_confirm_purchaser: true });

        const { data: ideaAfterConfirm } = await admin.from("gift_ideas").select("status").eq("id", idea).single();
        assert.equal(ideaAfterConfirm.status, "archived");

        const { data: buyerNotifications } = await buyer.client.from("notifications").select("*").eq("idea_id", idea);
        assert.equal(buyerNotifications.length, 1);
        assert.equal(buyerNotifications[0].type, "gift_received_purchased_confirmed");

        const { data: reservationAfter } = await admin.from("gift_reservations").select("status").eq("id", created.id).single();
        assert.equal(reservationAfter.status, "completed");
    });

    await test("purchased + Dostałem -> Nie/Nie wiem -> brak potwierdzającego powiadomienia", async () => {
        const buyer = await createUser("notifyno");
        const group = await makeSharedGroup(owner.id, [buyer.id]);
        const idea = await makeIdea(owner.id, group, "notify-no-1");
        await reserve(buyer.client, idea);
        const { data: created } = await buyer.client.from("gift_reservations").select().eq("idea_id", idea).single();
        await buyer.client.from("gift_reservations").update({ status: "purchased" }).eq("id", created.id);

        await owner.client.rpc("mark_idea_received", { p_idea_id: idea });
        await owner.client.rpc("mark_idea_received", { p_idea_id: idea, p_confirm_purchaser: false });

        const { data: ideaAfter } = await admin.from("gift_ideas").select("status").eq("id", idea).single();
        assert.equal(ideaAfter.status, "archived", "pomysł i tak trafia do archiwum");

        const { data: buyerNotifications } = await buyer.client.from("notifications").select("*").eq("idea_id", idea);
        assert.equal(buyerNotifications.length, 0, "brak potwierdzenia = brak powiadomienia sugerującego rozpoznanie");
    });

    await cleanup();

    console.log(`\n${passed} testów przeszło.`);
    if (process.exitCode) {
        console.error("Niektóre testy nie przeszły.");
    } else {
        console.log("Wszystkie testy przeszły.");
    }
}

main().catch(async (err) => {
    console.error(err);
    await cleanup();
    process.exit(1);
});
