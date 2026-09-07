import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '.env');

if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split(/\r?\n/)) {
        if (!line || line.trim().startsWith('#')) continue;
        const separatorIndex = line.indexOf('=');
        if (separatorIndex === -1) continue;

        const key = line.slice(0, separatorIndex).trim();
        const rawValue = line.slice(separatorIndex + 1).trim();
        const value = rawValue.replace(/^['"]|['"]$/g, '');

        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error('Ustaw SUPABASE_URL i SUPABASE_SERVICE_ROLE_KEY w środowisku przed uruchomieniem skryptu.');
}

const password = '%TGBnhy6';

const userSeeds = [
    { full_name: 'Maja Wójcik', city: 'Warszawa' },
    { full_name: 'Kamil Duda', city: 'Kraków' },
    { full_name: 'Aneta Kaczmarek', city: 'Gdańsk' },
    { full_name: 'Patryk Nowak', city: 'Poznań' },
    { full_name: 'Iga Zając', city: 'Wrocław' },
    { full_name: 'Oskar Szymański', city: 'Łódź' },
    { full_name: 'Natalia Pawlak', city: 'Katowice' },
    { full_name: 'Jakub Wiśniewski', city: 'Lublin' },
    { full_name: 'Zuzanna Mazur', city: 'Białystok' },
    { full_name: 'Filip Adamczyk', city: 'Szczecin' },
    { full_name: 'Karolina Lis', city: 'Rzeszów' },
];

const categories = ['elektronika', 'dom', 'podroz', 'moda', 'sport', 'książki', 'jedzenie', 'doświadczenie'];
const priorities = ['bardzo', 'chce', 'moze'];

const ideaTemplates = [
    { title: 'Słuchawki bezprzewodowe', description: 'Na długie spacery i pracę z domu.', category: 'elektronika', store: 'AudioLab', price: 499, priority: 'bardzo' },
    { title: 'Zestaw do kawy pour-over', description: 'Do codziennej rutyny i przyjaznych poranków.', category: 'dom', store: 'Materia Studio', price: 249, priority: 'chce' },
    { title: 'Weekend w górach', description: 'Dwa dni w spokojnym miejscu z widokiem na las.', category: 'podroz', store: 'TripNow', price: 680, priority: 'bardzo' },
    { title: 'Płaszcz z wełny', description: 'Ciepły i elegancki na jesienne wieczory.', category: 'moda', store: 'Vero', price: 320, priority: 'chce' },
    { title: 'Karnet na basen', description: 'Dla aktywności i lepszego samopoczucia.', category: 'sport', store: 'AquaFit', price: 180, priority: 'moze' },
    { title: 'Książka o rozwoju osobistym', description: 'Na spokojne wieczory i nowe nawyki.', category: 'książki', store: 'Papierowa Książka', price: 89, priority: 'moze' },
    { title: 'Set do degustacji', description: 'Kolacja z ciekawymi smakami i winem.', category: 'jedzenie', store: 'Smak i Sztuka', price: 260, priority: 'chce' },
    { title: 'Bilety na koncert', description: 'Na wspólne wydarzenie z ulubioną muzyką.', category: 'doświadczenie', store: 'Fala Event', price: 540, priority: 'bardzo' },
];

const baseUrl = SUPABASE_URL.replace(/\/$/, '');

async function deleteAuthUser(userId) {
    const response = await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
            'apikey': SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        },
    });

    return response.ok;
}

async function deleteTableRows(tableName) {
    const response = await fetch(`${baseUrl}/rest/v1/${tableName}?select=id`, {
        method: 'GET',
        headers: {
            'apikey': SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        },
    });

    if (!response.ok) {
        return;
    }

    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) {
        return;
    }

    for (const row of rows) {
        await fetch(`${baseUrl}/rest/v1/${tableName}?id=eq.${row.id}`, {
            method: 'DELETE',
            headers: {
                'apikey': SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
            },
        });
    }
}

async function resetDemoData() {
    const usersResponse = await fetch(`${baseUrl}/auth/v1/admin/users?per_page=100`, {
        method: 'GET',
        headers: {
            'apikey': SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        },
    });

    if (usersResponse.ok) {
        const payload = await usersResponse.json();
        const users = Array.isArray(payload?.users) ? payload.users : [];
        for (const user of users.filter((item) => item.email?.includes('jakub.jacek.chmielewski+'))) {
            await deleteAuthUser(user.id);
            console.log(`🧹 Removed stale demo user: ${user.email}`);
        }
    }

    await deleteTableRows('gift_ideas');
    await deleteTableRows('friendships');
    await deleteTableRows('profiles');
    await deleteTableRows('group_members');
    await deleteTableRows('idea_groups');
}

async function createAuthUser(fullName, index) {
    const email = `jakub.jacek.chmielewski+${index}@gmail.com`;

    const response = await fetch(`${baseUrl}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
            email,
            password,
            email_confirm: true,
            user_metadata: {
                full_name: fullName,
                city: userSeeds[index - 1]?.city ?? 'Warszawa',
            },
        }),
    });

    const payload = await response.json();

    if (!response.ok) {
        const message = payload?.message ?? 'unknown error';
        throw new Error(`User ${email} create failed: ${message}`);
    }

    const user = payload?.user ?? payload;
    if (!user?.id) {
        throw new Error(`User ${email} response did not include an id: ${JSON.stringify(payload)}`);
    }

    return {
        id: user.id,
        email,
        full_name: user.user_metadata?.full_name ?? fullName,
        city: user.user_metadata?.city ?? userSeeds[index - 1]?.city ?? 'Warszawa',
    };
}

async function insertProfile(profile) {
    const response = await fetch(`${baseUrl}/rest/v1/profiles?on_conflict=id`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
            'Prefer': 'return=representation,resolution=merge-duplicates',
        },
        body: JSON.stringify({
            id: profile.id,
            email: profile.email,
            full_name: profile.full_name,
            city: profile.city,
            avatar_url: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=600&q=80',
            birthday: '12 marca',
        }),
    });

    const payload = await response.json();
    if (!response.ok) {
        throw new Error(`Profile insert failed: ${JSON.stringify(payload)}`);
    }

    return payload[0] ?? payload;
}

async function createFriendships(profiles) {
    for (const profile of profiles) {
        const shuffled = [...profiles]
            .filter((candidate) => candidate.id !== profile.id)
            .sort(() => Math.random() - 0.5)
            .slice(0, 6);

        for (const friend of shuffled) {
            const response = await fetch(`${baseUrl}/rest/v1/friendships`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SERVICE_ROLE_KEY,
                    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                },
                body: JSON.stringify({
                    user_id: profile.id,
                    friend_id: friend.id,
                }),
            });

            if (!response.ok) {
                const payload = await response.text();
                console.warn(`Friendship failed for ${profile.email} -> ${friend.email}: ${payload}`);
            }
        }
    }
}

async function createIdeas(profiles) {
    for (const profile of profiles) {
        const count = 3 + ((profile.full_name.length + profile.email.length) % 3);
        const selected = [...ideaTemplates].sort(() => Math.random() - 0.5).slice(0, count);

        for (let index = 0; index < selected.length; index += 1) {
            const idea = selected[index];
            const response = await fetch(`${baseUrl}/rest/v1/gift_ideas`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SERVICE_ROLE_KEY,
                    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                    'Prefer': 'return=representation',
                },
                body: JSON.stringify({
                    user_id: profile.id,
                    title: idea.title,
                    description: idea.description,
                    category: idea.category,
                    store: idea.store,
                    price: idea.price,
                    image_url: 'https://images.unsplash.com/photo-1524758631624-e2822e304c36?auto=format&fit=crop&w=900&q=80',
                    priority: priorities[(index + profile.full_name.length) % priorities.length],
                    visibility: ['rodzina', 'znajomi', 'padel'],
                    favorite: index % 2 === 0,
                }),
            });

            if (!response.ok) {
                const payload = await response.text();
                console.warn(`Idea insert failed for ${profile.email}: ${payload}`);
            }
        }
    }
}

const main = async () => {
    await resetDemoData();

    const createdProfiles = [];

    for (let index = 0; index < userSeeds.length; index += 1) {
        const profile = await createAuthUser(userSeeds[index].full_name, index + 1);
        const saved = await insertProfile(profile);
        createdProfiles.push(saved);
        console.log(`✅ Created: ${profile.email}`);
    }

    await createFriendships(createdProfiles);
    await createIdeas(createdProfiles);

    console.log('🎉 Demo users, friendships and gift ideas created successfully.');
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
