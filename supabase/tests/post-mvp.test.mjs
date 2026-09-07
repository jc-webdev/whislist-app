// Testy dla: (a) poprawek zgłoszonych w nocy z 6 na 7.09.2026 (globalny
// przełącznik rezerwacji, widoczność "Wszyscy znajomi" w rezerwacjach) i
// (b) trzech etapów post-MVP: "Podrzuć pomysł" (15), "Wspólne prezenty" (17).
// Etap 16 ("Znajdź prezent") nie ma tu testów — to czysto kliencki filtr bez
// żadnej nowej logiki bazodanowej.
//
// Uruchomienie: node supabase/tests/post-mvp.test.mjs (z katalogu supabase/)
// Wymaga supabase/.env z SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// i wymaga, żeby zaktualizowany schema.sql był już wklejony do Supabase.

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
    const email = `postmvp-test+${label}-${STAMP}@example.com`;
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

async function makeIdea(ownerId, groupId, extra = {}) {
    const { data: idea, error } = await admin
        .from("gift_ideas")
        .insert({ user_id: ownerId, title: extra.title ?? "Pomysł", priority: "chce", ...extra })
        .select()
        .single();
    if (error) throw error;
    if (groupId) {
        const { error: visError } = await admin.from("idea_visibility").insert({ idea_id: idea.id, group_id: groupId });
        if (visError) throw visError;
    }
    return idea.id;
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
    const friendA = await createUser("frienda");
    const friendB = await createUser("friendb");
    await admin.from("friendships").insert({ user_id: owner.id, friend_id: friendA.id });
    await admin.from("friendships").insert({ user_id: owner.id, friend_id: friendB.id });
    await admin.from("friendships").insert({ user_id: friendA.id, friend_id: friendB.id });

    // ---- Globalny przełącznik rezerwacji ----

    await test("globalny przełącznik OFF blokuje rezerwację mimo grupy z włączonymi rezerwacjami", async () => {
        const group = await makeSharedGroup(owner.id, [friendA.id]);
        const idea = await makeIdea(owner.id, group);
        await admin.from("profiles").update({ reservations_enabled: false }).eq("id", owner.id);

        const { error } = await friendA.client.from("gift_reservations").insert({ idea_id: idea, reserved_by: friendA.id });
        assert.ok(error, "rezerwacja powinna być zablokowana globalnym przełącznikiem");

        await admin.from("profiles").update({ reservations_enabled: true }).eq("id", owner.id);
        const { error: afterEnableError } = await friendA.client.from("gift_reservations").insert({ idea_id: idea, reserved_by: friendA.id });
        assert.equal(afterEnableError, null, "po włączeniu z powrotem rezerwacja powinna przejść");
    });

    await test("visible_to_all pozwala na rezerwację bez żadnej grupy", async () => {
        const idea = await makeIdea(owner.id, null, { visible_to_all: true });
        const { error } = await friendB.client.from("gift_reservations").insert({ idea_id: idea, reserved_by: friendB.id });
        assert.equal(error, null);
    });

    await test("przełącznik rezerwacji per pomysł blokuje rezerwację mimo grupy i profilu z włączonymi rezerwacjami", async () => {
        const group = await makeSharedGroup(owner.id, [friendA.id]);
        const idea = await makeIdea(owner.id, group, { reservations_enabled: false });

        const { error } = await friendA.client.from("gift_reservations").insert({ idea_id: idea, reserved_by: friendA.id });
        assert.ok(error, "rezerwacja powinna być zablokowana przełącznikiem na samym pomyśle");

        await admin.from("gift_ideas").update({ reservations_enabled: true }).eq("id", idea);
        const { error: afterEnableError } = await friendA.client.from("gift_reservations").insert({ idea_id: idea, reserved_by: friendA.id });
        assert.equal(afterEnableError, null, "po włączeniu z powrotem rezerwacja powinna przejść");
    });

    // ---- ETAP 15 — Podrzuć pomysł ----

    await test("sugestia: nadawca może wysłać znajomemu, dostaje notyfikację, obcy nie może", async () => {
        const outsider = await createUser("outsider1");
        const { error: notFriendError } = await outsider.client
            .from("idea_suggestions")
            .insert({ sender_id: outsider.id, recipient_id: owner.id, title: "Nieznajomy prezent" });
        assert.ok(notFriendError, "obcy nie powinien móc wysłać sugestii");

        const { data: suggestion, error } = await friendA.client
            .from("idea_suggestions")
            .insert({ sender_id: friendA.id, recipient_id: owner.id, title: "Fajne słuchawki", url: "https://example.com" })
            .select()
            .single();
        assert.equal(error, null);

        const { data: notifications } = await owner.client.from("notifications").select("*").eq("type", "idea_suggestion_received");
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].related_user_id, friendA.id);

        // Nadawca nie może sam sobie zmienić statusu.
        const { error: senderUpdateError } = await friendA.client
            .from("idea_suggestions")
            .update({ status: "accepted" })
            .eq("id", suggestion.id);
        // RLS z "using" nie dopasuje żadnego wiersza (0 rows affected), Supabase zwraca sukces bez zmiany —
        // sprawdzamy więc realny efekt, nie sam brak błędu.
        const { data: afterSenderAttempt } = await admin.from("idea_suggestions").select("status").eq("id", suggestion.id).single();
        assert.equal(afterSenderAttempt.status, "pending", "nadawca nie powinien móc zmienić statusu");
        void senderUpdateError;

        // Odbiorca akceptuje: dodaje do swoich pomysłów + status accepted.
        const { error: acceptError } = await owner.client.from("idea_suggestions").update({ status: "accepted" }).eq("id", suggestion.id);
        assert.equal(acceptError, null);
        const { data: ownerIdea, error: insertError } = await owner.client
            .from("gift_ideas")
            .insert({ user_id: owner.id, title: suggestion.title, url: suggestion.url, priority: "chce" })
            .select()
            .single();
        assert.equal(insertError, null);
        assert.equal(ownerIdea.title, "Fajne słuchawki");
    });

    // ---- ETAP 17 — Wspólne prezenty ----

    await test("create_gift_plan: właściciel nie może organizować własnego pomysłu", async () => {
        const idea = await makeIdea(owner.id, null, { visible_to_all: true });
        const { error } = await owner.client.rpc("create_gift_plan", { p_idea_id: idea });
        assert.ok(error);
        assert.match(error.message, /CANNOT_ORGANIZE_OWN_IDEA/);
    });

    await test("create_gift_plan: blokuje pomysł niewidoczny dla wywołującego", async () => {
        const idea = await makeIdea(owner.id, null); // prywatny, brak grupy, visible_to_all=false
        const { error } = await friendA.client.rpc("create_gift_plan", { p_idea_id: idea });
        assert.ok(error);
        assert.match(error.message, /IDEA_NOT_VISIBLE/);
    });

    await test("create_gift_plan + invite + respond: pełny happy path, właściciel nigdy nic nie widzi", async () => {
        const group = await makeSharedGroup(owner.id, [friendA.id]);
        const idea = await makeIdea(owner.id, group, { title: "Wspólny prezent" });

        const { data: planId, error: createError } = await friendA.client.rpc("create_gift_plan", { p_idea_id: idea });
        assert.equal(createError, null);

        // Właściciel pomysłu nie widzi planu ani uczestników.
        const { data: ownerPlans } = await owner.client.from("gift_plans").select("*").eq("id", planId);
        assert.equal(ownerPlans.length, 0, "właściciel nie powinien widzieć gift_plans dla własnego pomysłu");
        const { data: ownerParticipants } = await owner.client.from("gift_plan_participants").select("*").eq("gift_plan_id", planId);
        assert.equal(ownerParticipants.length, 0, "właściciel nie powinien widzieć uczestników");

        // Twórca widzi swój plan i jest 'joined'.
        const { data: creatorParticipants } = await friendA.client.from("gift_plan_participants").select("*").eq("gift_plan_id", planId);
        assert.equal(creatorParticipants.length, 1);
        assert.equal(creatorParticipants[0].status, "joined");

        // Zaproszenie właściciela pomysłu do WŁASNEGO planu jest zablokowane.
        const { error: inviteOwnerError } = await friendA.client.rpc("invite_to_gift_plan", { p_plan_id: planId, p_user_id: owner.id });
        assert.ok(inviteOwnerError);
        assert.match(inviteOwnerError.message, /CANNOT_INVITE_IDEA_OWNER/);

        // Zaproszenie kogoś, kto nie jest znajomym zapraszającego.
        const outsider = await createUser("outsider2");
        const { error: inviteStrangerError } = await friendA.client.rpc("invite_to_gift_plan", { p_plan_id: planId, p_user_id: outsider.id });
        assert.ok(inviteStrangerError);
        assert.match(inviteStrangerError.message, /NOT_A_FRIEND/);

        // Poprawne zaproszenie friendB (znajomy friendA).
        const { error: inviteError } = await friendA.client.rpc("invite_to_gift_plan", { p_plan_id: planId, p_user_id: friendB.id });
        assert.equal(inviteError, null);

        const { data: friendBNotifications } = await friendB.client.from("notifications").select("*").eq("type", "gift_plan_invite");
        assert.equal(friendBNotifications.length, 1);
        assert.equal(friendBNotifications[0].related_user_id, friendA.id);
        assert.equal(friendBNotifications[0].idea_id, idea);

        // friendB, mimo że nie widział pomysłu wcześniej (nie ma grupy z ownerem
        // wspólnej — jest tylko znajomym friendA), teraz go widzi dzięki uczestnictwu w planie.
        const { data: ideaForFriendB } = await friendB.client.from("gift_ideas").select("*").eq("id", idea);
        assert.equal(ideaForFriendB.length, 1, "uczestnik planu powinien widzieć TEN pomysł, nawet bez bezpośredniej widoczności");

        // Ktoś niepowiązany nadal go nie widzi.
        const { data: ideaForOutsider } = await outsider.client.from("gift_ideas").select("*").eq("id", idea);
        assert.equal(ideaForOutsider.length, 0);

        // friendB odpowiada "tak" — status joined.
        const { error: respondError } = await friendB.client.rpc("respond_to_gift_plan_invite", { p_plan_id: planId, p_accept: true });
        assert.equal(respondError, null);
        const { data: friendBParticipation } = await friendB.client
            .from("gift_plan_participants")
            .select("status")
            .eq("gift_plan_id", planId)
            .eq("user_id", friendB.id)
            .single();
        assert.equal(friendBParticipation.status, "joined");

        // Nie da się odpowiedzieć drugi raz na to samo zaproszenie (status już nie jest 'invited').
        const { error: secondRespondError } = await friendB.client.rpc("respond_to_gift_plan_invite", { p_plan_id: planId, p_accept: false });
        assert.ok(secondRespondError);
        assert.match(secondRespondError.message, /INVITE_NOT_FOUND/);

        // Nadal właściciel nic nie widzi po tym wszystkim.
        const { data: ownerPlansAfter } = await owner.client.from("gift_plans").select("*").eq("id", planId);
        assert.equal(ownerPlansAfter.length, 0);

        await admin.auth.admin.deleteUser(outsider.id);
    });

    await test("invite_to_gift_plan: tylko uczestnik może zapraszać", async () => {
        const group = await makeSharedGroup(owner.id, [friendA.id, friendB.id]);
        const idea = await makeIdea(owner.id, group);
        const { data: planId } = await friendA.client.rpc("create_gift_plan", { p_idea_id: idea });

        const { error } = await friendB.client.rpc("invite_to_gift_plan", { p_plan_id: planId, p_user_id: owner.id });
        assert.ok(error, "friendB nie jest jeszcze uczestnikiem tego planu");
        assert.match(error.message, /NOT_A_PARTICIPANT|CANNOT_INVITE_IDEA_OWNER/);
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
