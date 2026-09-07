// Testy dla trzech etapów post-MVP dobudowanych po "Wspólnych prezentach":
// ETAP 8 — Okazje, ETAP PO MVP 18 — Czat, ETAP PO MVP 19 — Ankiety.
//
// Uruchomienie: node supabase/tests/occasions-chat-polls.test.mjs (z katalogu supabase/)
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
    const email = `ocp-test+${label}-${STAMP}@example.com`;
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
    const outsider = await createUser("outsider");
    await admin.from("friendships").insert({ user_id: owner.id, friend_id: friendA.id });
    await admin.from("friendships").insert({ user_id: owner.id, friend_id: friendB.id });
    await admin.from("friendships").insert({ user_id: friendA.id, friend_id: friendB.id });

    // ---- ETAP 8 — Okazje ----

    await test("okazja bez grupy jest widoczna dla wszystkich znajomych, nie dla obcych", async () => {
        const { data: occasion, error } = await owner.client
            .from("occasions")
            .insert({ owner_id: owner.id, name: "Urodziny", occasion_date: "1994-03-11" })
            .select()
            .single();
        assert.equal(error, null);

        const { data: forFriend } = await friendA.client.from("occasions").select("*").eq("id", occasion.id);
        assert.equal(forFriend.length, 1);
        const { data: forOutsider } = await outsider.client.from("occasions").select("*").eq("id", occasion.id);
        assert.equal(forOutsider.length, 0);
    });

    await test("okazja z group_id jest widoczna tylko członkom tej grupy", async () => {
        const group = await makeSharedGroup(owner.id, [friendA.id]);
        const { data: occasion, error } = await owner.client
            .from("occasions")
            .insert({ owner_id: owner.id, name: "Imieniny", occasion_date: "2026-06-01", group_id: group })
            .select()
            .single();
        assert.equal(error, null);

        const { data: forMember } = await friendA.client.from("occasions").select("*").eq("id", occasion.id);
        assert.equal(forMember.length, 1);
        const { data: forNonMember } = await friendB.client.from("occasions").select("*").eq("id", occasion.id);
        assert.equal(forNonMember.length, 0, "friendB jest znajomym, ale nie należy do grupy");
    });

    await test("tylko właściciel może wstawić/usunąć swoją okazję", async () => {
        const { error: insertOtherError } = await friendA.client
            .from("occasions")
            .insert({ owner_id: owner.id, name: "Fałszywa okazja", occasion_date: "2026-01-01" });
        assert.ok(insertOtherError, "nie można wstawić okazji w imieniu kogoś innego");

        const { data: occasion } = await owner.client
            .from("occasions")
            .insert({ owner_id: owner.id, name: "Do skasowania", occasion_date: "2026-05-05" })
            .select()
            .single();
        const { error: deleteOtherError } = await friendA.client.from("occasions").delete().eq("id", occasion.id);
        void deleteOtherError;
        const { data: stillThere } = await admin.from("occasions").select("*").eq("id", occasion.id);
        assert.equal(stillThere.length, 1, "friendA nie powinien móc skasować cudzej okazji");

        const { error: ownDeleteError } = await owner.client.from("occasions").delete().eq("id", occasion.id);
        assert.equal(ownDeleteError, null);
    });

    // ---- ETAP PO MVP 18 — Czat ----

    await test("chat_messages: tylko uczestnicy planu widzą i piszą, właściciel pomysłu nie", async () => {
        const group = await makeSharedGroup(owner.id, [friendA.id]);
        const idea = await makeIdea(owner.id, group, { title: "Wspólny prezent do czatu" });
        const { data: planId } = await friendA.client.rpc("create_gift_plan", { p_idea_id: idea });
        await friendA.client.rpc("invite_to_gift_plan", { p_plan_id: planId, p_user_id: friendB.id });
        await friendB.client.rpc("respond_to_gift_plan_invite", { p_plan_id: planId, p_accept: true });

        const { error: msgError } = await friendA.client
            .from("chat_messages")
            .insert({ gift_plan_id: planId, sender_id: friendA.id, message: "Cześć, co kupujemy?" });
        assert.equal(msgError, null);

        const { data: forParticipant } = await friendB.client.from("chat_messages").select("*").eq("gift_plan_id", planId);
        assert.equal(forParticipant.length, 1);

        const { data: forOwner } = await owner.client.from("chat_messages").select("*").eq("gift_plan_id", planId);
        assert.equal(forOwner.length, 0, "właściciel pomysłu nie powinien widzieć czatu o swoim prezencie");

        const { error: outsiderInsertError } = await outsider.client
            .from("chat_messages")
            .insert({ gift_plan_id: planId, sender_id: outsider.id, message: "Wpuśćcie mnie" });
        assert.ok(outsiderInsertError, "obcy nie może pisać w czacie planu, którego nie jest uczestnikiem");

        const { error: impersonateError } = await friendB.client
            .from("chat_messages")
            .insert({ gift_plan_id: planId, sender_id: friendA.id, message: "Podszywam się" });
        assert.ok(impersonateError, "nie można wysłać wiadomości jako ktoś inny");
    });

    // ---- ETAP PO MVP 19 — Ankiety ----

    await test("polls: target_id nigdy nie widzi ankiety o sobie", async () => {
        const { data: poll, error } = await friendA.client
            .from("polls")
            .insert({ target_id: owner.id, created_by: friendA.id, question: "Co kupujemy Kubie?" })
            .select()
            .single();
        assert.equal(error, null);

        const { data: forTarget } = await owner.client.from("polls").select("*").eq("id", poll.id);
        assert.equal(forTarget.length, 0, "target nigdy nie może zobaczyć ankiety o sobie");

        const { data: forFriendB } = await friendB.client.from("polls").select("*").eq("id", poll.id);
        assert.equal(forFriendB.length, 1, "inny wspólny znajomy targetu powinien widzieć ankietę bez group_id");

        const { data: notifications } = await friendB.client.from("notifications").select("*").eq("type", "poll_created");
        assert.equal(notifications.length, 1);
    });

    await test("polls: nie można stworzyć ankiety o sobie ani o kimś, kto nie jest znajomym twórcy", async () => {
        const { error: selfError } = await owner.client
            .from("polls")
            .insert({ target_id: owner.id, created_by: owner.id, question: "O sobie?" });
        assert.ok(selfError);

        const { error: notFriendError } = await outsider.client
            .from("polls")
            .insert({ target_id: owner.id, created_by: outsider.id, question: "Obcy pyta o Kubę" });
        assert.ok(notFriendError, "twórca musi być znajomym targetu");
    });

    await test("polls z group_id: widoczna tylko dla członków tej grupy", async () => {
        const group = await makeSharedGroup(owner.id, [friendA.id]);
        const { data: poll, error } = await friendA.client
            .from("polls")
            .insert({ target_id: owner.id, created_by: friendA.id, question: "Grupowa ankieta", group_id: group })
            .select()
            .single();
        assert.equal(error, null);

        const { data: forNonMember } = await friendB.client.from("polls").select("*").eq("id", poll.id);
        assert.equal(forNonMember.length, 0, "friendB nie należy do tej grupy");
    });

    await test("poll_options/poll_votes: tylko twórca dodaje opcje, głosowanie upsertuje jeden głos na osobę, target nic nie widzi", async () => {
        const { data: poll } = await friendA.client
            .from("polls")
            .insert({ target_id: owner.id, created_by: friendA.id, question: "Prezent czy voucher?" })
            .select()
            .single();

        const { error: optionByOtherError } = await friendB.client
            .from("poll_options")
            .insert({ poll_id: poll.id, label: "Nielegalna opcja" });
        assert.ok(optionByOtherError, "tylko twórca ankiety dodaje opcje");

        const { data: options, error: optionsError } = await friendA.client
            .from("poll_options")
            .insert([
                { poll_id: poll.id, label: "Prezent" },
                { poll_id: poll.id, label: "Voucher" },
            ])
            .select();
        assert.equal(optionsError, null);
        assert.equal(options.length, 2);

        const { error: voteError } = await friendB.client
            .from("poll_votes")
            .upsert({ poll_id: poll.id, option_id: options[0].id, user_id: friendB.id }, { onConflict: "poll_id,user_id" });
        assert.equal(voteError, null);

        // Zmiana zdania: upsert nadpisuje głos, nie dubluje.
        const { error: revoteError } = await friendB.client
            .from("poll_votes")
            .upsert({ poll_id: poll.id, option_id: options[1].id, user_id: friendB.id }, { onConflict: "poll_id,user_id" });
        assert.equal(revoteError, null);

        const { data: votes } = await friendA.client.from("poll_votes").select("*").eq("poll_id", poll.id);
        assert.equal(votes.length, 1, "jeden głos na osobę, upsert powinien nadpisać poprzedni");
        assert.equal(votes[0].option_id, options[1].id);

        const { error: voteAsOtherError } = await friendB.client
            .from("poll_votes")
            .upsert({ poll_id: poll.id, option_id: options[0].id, user_id: friendA.id }, { onConflict: "poll_id,user_id" });
        assert.ok(voteAsOtherError, "nie można głosować w cudzym imieniu");

        const { data: optionsForTarget } = await owner.client.from("poll_options").select("*").eq("poll_id", poll.id);
        assert.equal(optionsForTarget.length, 0, "target nie widzi opcji ankiety o sobie");
        const { data: votesForTarget } = await owner.client.from("poll_votes").select("*").eq("poll_id", poll.id);
        assert.equal(votesForTarget.length, 0, "target nie widzi głosów ankiety o sobie");
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
