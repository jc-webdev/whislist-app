"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
    me as mockMe,
    priorityMeta,
    type Idea,
    type IdeaStatus,
    type Priority,
    type Person,
} from "@/lib/mock-data";
import { supabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";

type ProfileRow = {
    id: string;
    full_name: string;
    avatar_url: string | null;
    birthday: string | null;
    city: string | null;
    has_onboarded: boolean;
    reservations_enabled: boolean;
};

type GiftIdeaRow = {
    id: string;
    user_id: string;
    title: string;
    description: string | null;
    url: string | null;
    store: string | null;
    price: number | null;
    image_url: string | null;
    priority: Priority | null;
    favorite: boolean | null;
    created_at: string | null;
    status: IdeaStatus | null;
    archived_at: string | null;
    visible_to_all: boolean | null;
};

type ReservationStatus = { reserved: boolean; byMe: boolean };

type ReservationKind = "reserved" | "purchased" | "cancelled" | "completed";

type ReservationRow = {
    id: string;
    idea_id: string;
    status: ReservationKind;
    created_at: string;
};

type NotificationKind =
    | "gift_received_reserved"
    | "gift_received_purchased_confirmed"
    | "friend_request_received"
    | "friend_request_accepted"
    | "idea_suggestion_received"
    | "gift_plan_invite"
    | "poll_created";

type NotificationRow = {
    id: string;
    type: NotificationKind;
    idea_id: string | null;
    related_user_id: string | null;
    gift_plan_id: string | null;
    poll_id: string | null;
    read: boolean;
    created_at: string;
};

type FriendshipRow = {
    user_id: string;
    friend_id: string;
};

type FriendRequestRow = {
    id: string;
    sender_id: string;
    recipient_id: string;
    created_at: string;
};

type SuggestionStatus = "pending" | "accepted" | "dismissed";

type IdeaSuggestionRow = {
    id: string;
    sender_id: string;
    recipient_id: string;
    title: string;
    url: string | null;
    image_url: string | null;
    status: SuggestionStatus;
    created_at: string;
};

type GiftPlanRow = {
    id: string;
    idea_id: string;
    created_by: string;
    created_at: string;
};

type GiftPlanParticipantStatus = "invited" | "joined" | "declined";

type GiftPlanParticipantRow = {
    gift_plan_id: string;
    user_id: string;
    status: GiftPlanParticipantStatus;
    created_at: string;
};

type OccasionRow = {
    id: string;
    owner_id: string;
    name: string;
    occasion_date: string;
    group_id: string | null;
    created_at: string;
};

type ChatMessageRow = {
    id: string;
    gift_plan_id: string;
    sender_id: string;
    message: string;
    created_at: string;
};

type PollRow = {
    id: string;
    target_id: string;
    created_by: string;
    question: string;
    group_id: string | null;
    created_at: string;
};

type PollOptionRow = {
    id: string;
    poll_id: string;
    label: string;
    created_at: string;
};

type PollVoteRow = {
    poll_id: string;
    option_id: string;
    user_id: string;
    created_at: string;
};

type GroupRow = {
    id: string;
    owner_id: string;
    name: string;
    description: string | null;
    reservations_enabled: boolean;
    created_at: string;
};

type GroupMemberRow = {
    group_id: string;
    user_id: string;
};

type IdeaVisibilityRow = {
    idea_id: string;
    group_id: string;
};

function polishPlural(count: number, [one, few, many]: [string, string, string]): string {
    if (count === 1) return one;
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return few;
    return many;
}

const ideaWord = (count: number) => polishPlural(count, ["pomysł", "pomysły", "pomysłów"]);
const personWord = (count: number) => polishPlural(count, ["osoba", "osoby", "osób"]);

// Zgaduje nazwę sklepu z domeny linku (np. "https://www.empik.com/..." -> "Empik"),
// żeby nie zmuszać użytkownika do ręcznego wpisywania oczywistej rzeczy.
function guessStoreFromUrl(url: string): string {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, "");
        const labels = hostname.split(".");
        const main = labels.length > 2 ? labels[labels.length - 2] : labels[0];
        return main.charAt(0).toUpperCase() + main.slice(1);
    } catch {
        return "";
    }
}

// Kolory dobrane z palety appki (--sage/--accent/--danger/--muted i ich
// ciemniejsi kuzyni) — stały wybór per osoba (hash z id), nie losowany na
// nowo przy każdym renderze, żeby awatar nie migał innym kolorem po odświeżeniu.
const AVATAR_PALETTE = ["#7aa89b", "#2b7f74", "#b15947", "#5e726f", "#c9975a", "#5b7f9a"];

// Przed każdym uploadem do Storage: przeskalowanie do rozsądnego maksimum i
// konwersja do WebP z canvas (natywne API przeglądarki, bez zależności typu
// browser-image-compression) — telefonowe zdjęcie 8 MB potrafi spaść do
// kilkuset KB bez zauważalnej straty jakości. GIF pomijamy (animacja), żeby
// nie zgubić klatek. Przy jakimkolwiek błędzie (np. plik nie jest obrazem)
// cicho zwraca oryginalny plik — upload i tak dalej zadziała, tylko bez
// oszczędności rozmiaru.
async function compressImageFile(file: File, maxDimension = 1600, quality = 0.82): Promise<File> {
    if (file.type === "image/gif" || !file.type.startsWith("image/")) return file;
    try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
        const width = Math.round(bitmap.width * scale);
        const height = Math.round(bitmap.height * scale);

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return file;
        ctx.drawImage(bitmap, 0, 0, width, height);

        const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
        if (!blob || blob.size >= file.size) return file;

        const newName = file.name.replace(/\.[^.]+$/, "") + ".webp";
        return new File([blob], newName, { type: "image/webp" });
    } catch {
        return file;
    }
}

function colorForId(id: string): string {
    let hash = 0;
    for (let i = 0; i < id.length; i += 1) {
        hash = id.charCodeAt(i) + ((hash << 5) - hash);
    }
    return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function initialsFor(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Avatar({
    id,
    name,
    avatarUrl,
    size,
    className = "",
}: {
    id: string;
    name: string;
    avatarUrl?: string | null;
    size: "small" | "medium" | "large";
    className?: string;
}) {
    const sizeClass = size === "medium" ? "" : ` ${size}`;
    if (avatarUrl) {
        return <img src={avatarUrl} alt={name} className={`avatar${sizeClass} ${className}`.trim()} />;
    }
    return (
        <div
            className={`avatar avatar-initials${sizeClass} ${className}`.trim()}
            style={{ background: colorForId(id) }}
            aria-label={name}
        >
            {initialsFor(name)}
        </div>
    );
}

function BackButton({ onClick, label = "Wróć" }: { onClick: () => void; label?: string }) {
    return (
        <button className="ghost-button back-button" onClick={onClick}>
            <IconArrowLeft className="back-button-icon" />
            {label}
        </button>
    );
}

const filters: Array<{ id: string; label: string }> = [
    { id: "wszystkie", label: "Wszystkie" },
    { id: "bardzo", label: "🔥 Bardzo chcę" },
    { id: "chce", label: "❤️ Chcę" },
    { id: "moze", label: "🤷 Może kiedyś" },
    { id: "ulubione", label: "Ulubione" },
];

type ParsedRoute =
    | { screen: "ideas" }
    | { screen: "add"; editingIdeaId: string | null }
    | { screen: "detail"; owner: "mine"; ideaId: string }
    | { screen: "people" }
    | { screen: "add-friend" }
    | { screen: "friend-requests" }
    | { screen: "people-profile"; friendId: string }
    | { screen: "friend-list"; friendId: string }
    | { screen: "detail"; owner: "friend"; friendId: string; ideaId: string }
    | { screen: "gifts" }
    | { screen: "profile" }
    | { screen: "edit-profile" }
    | { screen: "privacy" }
    | { screen: "archive" }
    | { screen: "notifications" }
    | { screen: "suggest-idea"; friendId: string }
    | { screen: "gift-plans" }
    | { screen: "gift-plan-detail"; planId: string }
    | { screen: "occasions" }
    | { screen: "create-poll"; friendId: string }
    | { screen: "polls" }
    | { screen: "poll-detail"; pollId: string }
    | { screen: "invite"; code: string };

function parseRoute(pathname: string): ParsedRoute {
    const segments = pathname.split("/").filter(Boolean);

    if (segments.length === 0) return { screen: "ideas" };
    if (segments[0] === "add" && segments.length === 1) return { screen: "add", editingIdeaId: null };
    if (segments[0] === "ideas" && segments.length === 2) return { screen: "detail", owner: "mine", ideaId: segments[1] };
    if (segments[0] === "ideas" && segments.length === 3 && segments[2] === "edit") {
        return { screen: "add", editingIdeaId: segments[1] };
    }
    if (segments[0] === "people" && segments.length === 1) return { screen: "people" };
    if (segments[0] === "people" && segments.length === 2 && segments[1] === "add") return { screen: "add-friend" };
    if (segments[0] === "people" && segments.length === 2 && segments[1] === "requests") return { screen: "friend-requests" };
    if (segments[0] === "people" && segments.length === 3 && segments[2] === "suggest") {
        return { screen: "suggest-idea", friendId: segments[1] };
    }
    if (segments[0] === "people" && segments.length === 3 && segments[2] === "poll") {
        return { screen: "create-poll", friendId: segments[1] };
    }
    if (segments[0] === "people" && segments.length === 2) return { screen: "people-profile", friendId: segments[1] };
    if (segments[0] === "people" && segments.length === 3 && segments[2] === "ideas") {
        return { screen: "friend-list", friendId: segments[1] };
    }
    if (segments[0] === "people" && segments.length === 4 && segments[2] === "ideas") {
        return { screen: "detail", owner: "friend", friendId: segments[1], ideaId: segments[3] };
    }
    if (segments[0] === "gifts") return { screen: "gifts" };
    if (segments[0] === "profile" && segments.length === 2 && segments[1] === "edit") return { screen: "edit-profile" };
    if (segments[0] === "profile") return { screen: "profile" };
    if (segments[0] === "privacy") return { screen: "privacy" };
    if (segments[0] === "archive") return { screen: "archive" };
    if (segments[0] === "notifications") return { screen: "notifications" };
    if (segments[0] === "gift-plans" && segments.length === 1) return { screen: "gift-plans" };
    if (segments[0] === "gift-plans" && segments.length === 2) return { screen: "gift-plan-detail", planId: segments[1] };
    if (segments[0] === "occasions") return { screen: "occasions" };
    if (segments[0] === "polls" && segments.length === 1) return { screen: "polls" };
    if (segments[0] === "polls" && segments.length === 2) return { screen: "poll-detail", pollId: segments[1] };
    if (segments[0] === "invite" && segments.length === 2) return { screen: "invite", code: segments[1] };

    return { screen: "ideas" };
}

const PENDING_INVITE_KEY = "widoczek_pending_invite";

type InvitePreview = {
    owner_id: string;
    owner_name: string;
    owner_avatar_url: string | null;
    is_active: boolean;
    is_expired: boolean;
    is_self: boolean;
    already_friends: boolean;
};

// Wspólna ścieżka akceptacji: używana zarówno tuż po zalogowaniu/rejestracji
// (odzyskanie zaproszenia zapisanego w localStorage), jak i na ekranie
// zaproszenia dla już zalogowanego użytkownika. Sama walidacja (self/expired/
// nieaktywne/już znajomi) żyje w funkcji resolve_invite po stronie bazy.
async function tryAcceptInvite(code: string, myId: string): Promise<{ ownerId: string; ownerName: string } | null> {
    const { data, error } = await supabase.rpc("resolve_invite", { p_code: code }).single();
    const preview = data as InvitePreview | null;
    if (error || !preview || !preview.owner_id || preview.is_self || !preview.is_active || preview.is_expired) {
        return null;
    }

    if (!preview.already_friends) {
        const { error: insertError } = await supabase
            .from("friendships")
            .insert({ user_id: myId, friend_id: preview.owner_id });
        if (insertError) return null;
    }

    return { ownerId: preview.owner_id, ownerName: preview.owner_name };
}

function IconLock({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="11" width="14" height="10" rx="2.5" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
    );
}

function IconHeart({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20s-7-4.35-9.5-8.5C.7 8.2 2 4.5 5.5 4.5c2 0 3.5 1.2 4.5 2.7 1-1.5 2.5-2.7 4.5-2.7 3.5 0 4.8 3.7 3 7C15 15.65 12 20 12 20Z" />
        </svg>
    );
}

function IconUsers({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="9" cy="8" r="3" />
            <path d="M2 20c0-3.3 3.1-6 7-6s7 2.7 7 6" />
            <circle cx="17.5" cy="8.5" r="2.5" />
            <path d="M17 12.3c2.7.5 5 2.3 5 4.7" />
        </svg>
    );
}

function IconBell({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5Z" />
            <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
    );
}

function IconArrowLeft({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" />
            <path d="M11 6l-6 6 6 6" />
        </svg>
    );
}

function IconExternalLink({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 4h6v6" />
            <path d="M20 4 10 14" />
            <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
        </svg>
    );
}

function IconGift({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="9" width="18" height="4" rx="1" />
            <rect x="5" y="13" width="14" height="8" rx="1" />
            <path d="M12 9v12" />
            <path d="M12 9C10.5 5.5 6.5 5.3 6.5 7.8 6.5 9 8 9 12 9Z" />
            <path d="M12 9c1.5-3.5 5.5-3.7 5.5-1.2C17.5 9 16 9 12 9Z" />
        </svg>
    );
}

const LANDING_PILLS = [
    { Icon: IconHeart, label: "Zapisuj cały rok" },
    { Icon: IconUsers, label: "Grupy i widoczność" },
    { Icon: IconGift, label: "Łatwiej trafić w prezent" },
] as const;

function InviteMessageScreen({
    title,
    text,
    action,
}: {
    title: string;
    text: string;
    action?: { label: string; onClick: () => void };
}) {
    return (
        <div className="app-shell auth-shell">
            <div className="card body-card auth-card">
                <div className="eyebrow">WhishApp</div>
                <h1>{title}</h1>
                <p>{text}</p>
                {action ? (
                    <button className="primary-button" onClick={action.onClick}>{action.label}</button>
                ) : null}
            </div>
        </div>
    );
}

function InviteScreen({
    code,
    isAuthenticated,
    onAccept,
    onRegister,
    onLogin,
    onGoToProfile,
    onGoToAddFriend,
}: {
    code: string;
    isAuthenticated: boolean;
    onAccept: () => void | Promise<void>;
    onRegister: () => void;
    onLogin: () => void;
    onGoToProfile: (ownerId: string) => void;
    onGoToAddFriend: () => void;
}) {
    const [preview, setPreview] = useState<InvitePreview | "loading" | "error">("loading");
    const [accepting, setAccepting] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const { data, error } = await supabase.rpc("resolve_invite", { p_code: code }).single();
            const result = data as InvitePreview | null;
            if (cancelled) return;
            setPreview(error || !result || !result.owner_id ? "error" : result);
        })();
        return () => {
            cancelled = true;
        };
    }, [code]);

    if (preview === "loading") {
        return (
            <div className="app-shell auth-shell">
                <div className="card body-card"><h2>Ładowanie zaproszenia...</h2></div>
            </div>
        );
    }

    if (preview === "error") {
        return <InviteMessageScreen title="Nieprawidłowe zaproszenie" text="Ten link nie istnieje albo został usunięty." />;
    }

    const firstName = preview.owner_name.split(" ")[0] || preview.owner_name;

    if (preview.is_expired) {
        return <InviteMessageScreen title="Zaproszenie wygasło" text={`Poproś ${firstName} o nowy link.`} />;
    }
    if (!preview.is_active) {
        return (
            <InviteMessageScreen
                title="Zaproszenie nieaktywne"
                text={`${firstName} wygenerował od tego czasu nowy link — poproś o aktualny.`}
            />
        );
    }
    if (preview.is_self) {
        return (
            <InviteMessageScreen
                title="To Twój własny link"
                text="Udostępnij go znajomym, żeby dołączyli do Twoich ludzi."
                action={isAuthenticated ? { label: "Przejdź do Dodaj znajomego", onClick: onGoToAddFriend } : undefined}
            />
        );
    }
    if (preview.already_friends) {
        return (
            <InviteMessageScreen
                title="Jesteście już znajomymi"
                text={`Ty i ${firstName} już się znacie w Widoczku.`}
                action={isAuthenticated ? { label: `Zobacz profil ${firstName}`, onClick: () => onGoToProfile(preview.owner_id) } : undefined}
            />
        );
    }

    return (
        <div className="app-shell auth-shell">
            <div className="card body-card auth-card" style={{ textAlign: "center" }}>
                <Avatar id={preview.owner_id} name={preview.owner_name} avatarUrl={preview.owner_avatar_url} size="large" />
                <div className="eyebrow" style={{ marginTop: "12px" }}>WhishApp</div>
                <h1>{firstName} zaprasza Cię do swoich ludzi 🎁</h1>
                <p>Zobacz, co naprawdę chciałby dostać — bez zgadywania.</p>
                {isAuthenticated ? (
                    <button
                        className="primary-button"
                        disabled={accepting}
                        onClick={async () => {
                            setAccepting(true);
                            await onAccept();
                            setAccepting(false);
                        }}
                    >
                        {accepting ? "Łączenie..." : "Akceptuj zaproszenie"}
                    </button>
                ) : (
                    <>
                        <button className="primary-button" onClick={onRegister}>Załóż konto i zobacz pomysły {firstName}</button>
                        <button className="text-button" onClick={onLogin}>Mam już konto — zaloguj się</button>
                    </>
                )}
            </div>
        </div>
    );
}

function LandingScreen({ onRegister, onLogin }: { onRegister: () => void; onLogin: () => void }) {
    return (
        <div className="landing-screen">
            <div className="landing-wordmark">WhishApp</div>

            <div className="landing-hero">
                <h1>Powiedz swoim ludziom, co Ci się podoba</h1>
                <p>Bez proszenia ich o listę prezentów. Zapisujesz pomysły przez cały rok — reszta jest po ich stronie.</p>
            </div>

            <div className="landing-stack">
                <div className="landing-stack-card landing-stack-card--back" aria-hidden="true">
                    <img src="https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=400&q=60" alt="" />
                </div>
                <div className="landing-stack-card landing-stack-card--front">
                    <img src="https://images.unsplash.com/photo-1546435770-a3e426bf472b?auto=format&fit=crop&w=500&q=70" alt="Słuchawki zapisane jako pomysł na prezent" />
                    <div className="landing-stack-tag">🔥 Bardzo chcę</div>
                </div>
            </div>

            <div className="landing-statement">
                <IconLock className="landing-statement-icon" />
                <p>Znajomi mogą po cichu zarezerwować prezent z Twojej listy. Nigdy się nie dowiesz kto ani czy w ogóle.</p>
            </div>

            <div className="landing-pills">
                {LANDING_PILLS.map(({ Icon, label }) => (
                    <div className="landing-pill" key={label}>
                        <Icon className="landing-pill-icon" />
                        <span>{label}</span>
                    </div>
                ))}
            </div>

            <div className="landing-cta">
                <button className="primary-button" onClick={onRegister}>Załóż darmowe konto</button>
                <button className="text-button" onClick={onLogin}>Mam już konto — zaloguj się</button>
                <div className="hint">Zawsze darmowe dla użytkowników.</div>
            </div>
        </div>
    );
}

const ONBOARDING_SLIDES = [
    {
        title: "Zapisuj to, co Ci się spodobało",
        text: "Rzeczy, doświadczenia i wydarzenia. Wklej link albo dodaj ręcznie w kilka sekund — przez cały rok, nie tylko przed świętami.",
        pills: ["💭 Pomysły", "🔥 Priorytety", "❤️ Ulubione"],
    },
    {
        title: "Znajomi i grupy",
        text: "Dodawaj znajomych i twórz własne grupy — Rodzina, Praca, konkretna paczka ze sportu. Możesz należeć do wielu naraz.",
        pills: ["👥 Grupy", "🎾 np. Padel", "🏡 np. Rodzina"],
    },
    {
        title: "Ty decydujesz, kto to widzi",
        text: "Każdy pomysł udostępniasz wybranym grupom — albo zostawiasz tylko dla siebie. Nic nie jest widoczne domyślnie.",
        pills: ["🔒 Tylko ja", "👥 Wybrane grupy"],
    },
    {
        title: "Niespodzianka zostaje niespodzianką",
        text: "Znajomi mogą po cichu zarezerwować prezent z Twojej listy. Nigdy się nie dowiesz kto ani czy w ogóle ktoś to zrobił.",
        pills: ["🎁 Prezenty", "🔒 Ciche rezerwacje"],
    },
] as const;

function OnboardingScreen({
    onFinish,
    onAddFirstIdea,
}: {
    onFinish: () => void;
    onAddFirstIdea: (title: string, priority: Priority) => Promise<void>;
}) {
    const totalSteps = ONBOARDING_SLIDES.length + 1;
    const [step, setStep] = useState(0);
    const [ideaTitle, setIdeaTitle] = useState("");
    const [ideaPriority, setIdeaPriority] = useState<Priority>("chce");
    const [submitting, setSubmitting] = useState(false);
    const isFinalStep = step === ONBOARDING_SLIDES.length;

    const handleAddIdea = async () => {
        if (!ideaTitle.trim() || submitting) return;
        setSubmitting(true);
        await onAddFirstIdea(ideaTitle.trim(), ideaPriority);
    };

    return (
        <div className="app-shell">
            <div className="onboarding-screen">
                <div className="brand-row">
                    <div className="brand">WhishApp</div>
                    <button className="text-button" onClick={onFinish}>Pomiń</button>
                </div>

                <div className="onboarding-center">
                    {step > 0 && (
                        <button
                            className="onboarding-back back-button"
                            onClick={() => setStep((prev) => prev - 1)}
                            aria-label="Wróć do poprzedniego kroku"
                        >
                            <IconArrowLeft className="back-button-icon" />
                            Wróć
                        </button>
                    )}

                    <div className="onboarding-track-viewport">
                        <div
                            className="onboarding-track"
                            style={{ transform: `translateX(-${step * 100}%)` }}
                        >
                            {ONBOARDING_SLIDES.map((slide) => (
                                <div className="onboarding-slide" key={slide.title}>
                                    <div className="card image-card">
                                        <div className="card-body">
                                            <h1>{slide.title}</h1>
                                            <p>{slide.text}</p>
                                            <div className="badge-row">
                                                {slide.pills.map((pill) => (
                                                    <span key={pill} className="badge">{pill}</span>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}

                            <div className="onboarding-slide">
                                <div className="card image-card">
                                    <div className="card-body">
                                        <h1>Dodaj swój pierwszy pomysł</h1>
                                        <p>Opcjonalnie — zawsze możesz dodać go później. Jak zaczniesz, znajomi będą mieli od czego zacząć.</p>
                                        <input
                                            className="text-input"
                                            placeholder="Np. Słuchawki Sony WH-1000XM6"
                                            value={ideaTitle}
                                            onChange={(event) => setIdeaTitle(event.target.value)}
                                        />
                                        <div className="badge-row">
                                            {(Object.keys(priorityMeta) as Priority[]).map((key) => (
                                                <button
                                                    key={key}
                                                    type="button"
                                                    className={key === ideaPriority ? "badge badge-selectable active" : "badge badge-selectable"}
                                                    onClick={() => setIdeaPriority(key)}
                                                >
                                                    {priorityMeta[key].emoji} {priorityMeta[key].label}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="pager">
                        {Array.from({ length: totalSteps }).map((_, index) => (
                            <span key={index} className={index === step ? "dot active" : "dot"} />
                        ))}
                    </div>
                </div>

                {isFinalStep ? (
                    <button className="primary-button" onClick={handleAddIdea} disabled={!ideaTitle.trim() || submitting}>
                        {submitting ? "Dodaję..." : "Dodaj pomysł i zacznij"}
                    </button>
                ) : (
                    <button className="primary-button" onClick={() => setStep((prev) => prev + 1)}>
                        Dalej
                    </button>
                )}
            </div>
        </div>
    );
}

export function AppShell() {
    const router = useRouter();
    const pathname = usePathname();
    const route = useMemo(() => parseRoute(pathname), [pathname]);
    const screen = route.screen;
    const detailOwner = route.screen === "detail" ? route.owner : "mine";
    const editingIdeaId = route.screen === "add" ? route.editingIdeaId : null;
    const routeIdeaId = route.screen === "detail" ? route.ideaId : null;
    const routeFriendId =
        route.screen === "people-profile" ||
        route.screen === "friend-list" ||
        route.screen === "suggest-idea" ||
        route.screen === "create-poll" ||
        (route.screen === "detail" && route.owner === "friend")
            ? route.friendId
            : null;
    const routeInviteCode = route.screen === "invite" ? route.code : null;
    const routeGiftPlanId = route.screen === "gift-plan-detail" ? route.planId : null;
    const routePollId = route.screen === "poll-detail" ? route.pollId : null;

    const activeNavIndex =
        screen === "ideas" ? 0 : screen === "people" || screen === "people-profile" || screen === "friend-requests" ? 1 : screen === "gifts" ? 2 : screen === "profile" ? 3 : null;

    const goBack = () => {
        if (typeof window !== "undefined" && window.history.length > 1) {
            router.back();
        } else {
            router.push("/");
        }
    };

    const [reservationStatus, setReservationStatus] = useState<Record<string, ReservationStatus>>({});
    const [ideaActionError, setIdeaActionError] = useState<string>("");
    const [profileInfo, setProfileInfo] = useState<string>("");
    const [authLoading, setAuthLoading] = useState(true);
    const [session, setSession] = useState<Session | null>(null);
    const [authView, setAuthView] = useState<"landing" | "login" | "register" | "forgot" | "recovery">("landing");
    const [loginForm, setLoginForm] = useState({
        email: "",
        password: "",
    });
    const [registerForm, setRegisterForm] = useState({
        fullName: "",
        email: "",
        password: "",
    });
    const [forgotEmail, setForgotEmail] = useState("");
    const [recoveryPassword, setRecoveryPassword] = useState("");
    const [authError, setAuthError] = useState<string>("");
    const [authInfo, setAuthInfo] = useState<string>("");
    const [liveProfiles, setLiveProfiles] = useState<ProfileRow[]>([]);
    const [liveIdeas, setLiveIdeas] = useState<GiftIdeaRow[]>([]);
    const [liveFriendships, setLiveFriendships] = useState<FriendshipRow[]>([]);
    const [liveFriendRequests, setLiveFriendRequests] = useState<FriendRequestRow[]>([]);
    const [liveGroups, setLiveGroups] = useState<GroupRow[]>([]);
    const [liveGroupMembers, setLiveGroupMembers] = useState<GroupMemberRow[]>([]);
    const [liveIdeaVisibility, setLiveIdeaVisibility] = useState<IdeaVisibilityRow[]>([]);
    const [myInvite, setMyInvite] = useState<{ id: string } | null>(null);
    const [myReservations, setMyReservations] = useState<ReservationRow[]>([]);
    const [liveNotifications, setLiveNotifications] = useState<NotificationRow[]>([]);
    const [liveIdeaSuggestions, setLiveIdeaSuggestions] = useState<IdeaSuggestionRow[]>([]);
    const [liveGiftPlans, setLiveGiftPlans] = useState<GiftPlanRow[]>([]);
    const [liveGiftPlanParticipants, setLiveGiftPlanParticipants] = useState<GiftPlanParticipantRow[]>([]);
    const [liveOccasions, setLiveOccasions] = useState<OccasionRow[]>([]);
    const [livePolls, setLivePolls] = useState<PollRow[]>([]);
    const [livePollOptions, setLivePollOptions] = useState<PollOptionRow[]>([]);
    const [livePollVotes, setLivePollVotes] = useState<PollVoteRow[]>([]);
    // Wiadomości czatu ładujemy tylko dla aktualnie otwartego gift planu, nie
    // wszystkich naraz przy starcie sesji — w odróżnieniu od reszty tabel to
    // jedyna, która realnie rośnie bez ograniczeń w czasie.
    const [chatMessages, setChatMessages] = useState<ChatMessageRow[]>([]);
    const [chatDraft, setChatDraft] = useState("");
    const [confirmRequest, setConfirmRequest] = useState<{
        title: string;
        message?: string;
        confirmLabel: string;
        cancelLabel: string;
        danger?: boolean;
    } | null>(null);
    const confirmResolverRef = useRef<((value: boolean) => void) | null>(null);

    // Zastępuje window.confirm() własnym, spójnym stylistycznie dialogiem —
    // przeglądarkowe okienko psuło wygląd i nie dało się w nim ustawić
    // własnych etykiet przycisków.
    const askConfirm = (opts: { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => {
        return new Promise<boolean>((resolve) => {
            confirmResolverRef.current = resolve;
            setConfirmRequest({
                title: opts.title,
                message: opts.message,
                confirmLabel: opts.confirmLabel ?? "Potwierdź",
                cancelLabel: opts.cancelLabel ?? "Anuluj",
                danger: opts.danger,
            });
        });
    };

    const resolveConfirm = (value: boolean) => {
        confirmResolverRef.current?.(value);
        confirmResolverRef.current = null;
        setConfirmRequest(null);
    };
    const [peopleTab, setPeopleTab] = useState<"znajomi" | "grupy">("znajomi");
    const [notificationsTab, setNotificationsTab] = useState<"wszystkie" | "zaproszenia" | "sugestie">("wszystkie");
    const [activeFilter, setActiveFilter] = useState<string>("wszystkie");
    const [friendListFilter, setFriendListFilter] = useState<string>("wszystkie");

    useEffect(() => {
        const loadSession = async () => {
            const {
                data: { session: currentSession },
            } = await supabase.auth.getSession();
            setSession(currentSession);

            if (!currentSession) {
                setAuthLoading(false);
                return;
            }

            const [
                initialProfilesRes,
                ideasRes,
                friendshipsRes,
                friendRequestsRes,
                myReservationsRes,
                groupsRes,
                groupMembersRes,
                ideaVisibilityRes,
                notificationsRes,
                ideaSuggestionsRes,
                giftPlansRes,
                giftPlanParticipantsRes,
                occasionsRes,
                pollsRes,
                pollOptionsRes,
                pollVotesRes,
            ] = await Promise.all([
                    supabase.from("profiles").select("*").order("full_name", { ascending: true }),
                    supabase.from("gift_ideas").select("*").order("created_at", { ascending: false }),
                    supabase.from("friendships").select("*"),
                    supabase.from("friend_requests").select("*"),
                    supabase
                        .from("gift_reservations")
                        .select("id, idea_id, status, created_at")
                        .eq("reserved_by", currentSession.user.id),
                    supabase.from("idea_groups").select("*"),
                    supabase.from("group_members").select("*"),
                    supabase.from("idea_visibility").select("*"),
                    supabase
                        .from("notifications")
                        .select("id, type, idea_id, related_user_id, gift_plan_id, poll_id, read, created_at")
                        .order("created_at", { ascending: false })
                        .limit(50),
                    supabase.from("idea_suggestions").select("*").order("created_at", { ascending: false }),
                    supabase.from("gift_plans").select("*"),
                    supabase.from("gift_plan_participants").select("*"),
                    supabase.from("occasions").select("*"),
                    supabase.from("polls").select("*"),
                    supabase.from("poll_options").select("*"),
                    supabase.from("poll_votes").select("*"),
                ]);

            let profilesRes = initialProfilesRes;
            const hasOwnProfile = profilesRes.data?.some((row) => row.id === currentSession.user.id);
            if (!hasOwnProfile) {
                const metadata = currentSession.user.user_metadata ?? {};
                await supabase.from("profiles").insert({
                    id: currentSession.user.id,
                    email: currentSession.user.email,
                    full_name: metadata.full_name ?? currentSession.user.email,
                    city: metadata.city ?? null,
                });
                profilesRes = await supabase.from("profiles").select("*").order("full_name", { ascending: true });
            }

            if (profilesRes.data) setLiveProfiles(profilesRes.data);
            if (ideasRes.data) setLiveIdeas(ideasRes.data);
            if (friendRequestsRes.data) setLiveFriendRequests(friendRequestsRes.data);
            let nextFriendships = friendshipsRes.data ?? [];
            if (myReservationsRes.data) setMyReservations(myReservationsRes.data);
            if (groupsRes.data) setLiveGroups(groupsRes.data);
            if (groupMembersRes.data) setLiveGroupMembers(groupMembersRes.data);
            if (ideaVisibilityRes.data) setLiveIdeaVisibility(ideaVisibilityRes.data);
            if (notificationsRes.data) setLiveNotifications(notificationsRes.data);
            if (ideaSuggestionsRes.data) setLiveIdeaSuggestions(ideaSuggestionsRes.data);
            if (giftPlansRes.data) setLiveGiftPlans(giftPlansRes.data);
            if (giftPlanParticipantsRes.data) setLiveGiftPlanParticipants(giftPlanParticipantsRes.data);
            if (occasionsRes.data) setLiveOccasions(occasionsRes.data);
            if (pollsRes.data) setLivePolls(pollsRes.data);
            if (pollOptionsRes.data) setLivePollOptions(pollOptionsRes.data);
            if (pollVotesRes.data) setLivePollVotes(pollVotesRes.data);

            // Zaproszenie zapisane przed rejestracją/logowaniem (patrz LandingScreen
            // przez InviteScreen) — odzyskujemy je tutaj, bo to jedyne miejsce, przez
            // które przechodzi KAŻDA droga do posiadania sesji (świeża rejestracja,
            // potwierdzenie e-mail w innej karcie, zwykłe logowanie).
            const pendingCode = typeof window !== "undefined" ? window.localStorage.getItem(PENDING_INVITE_KEY) : null;
            if (pendingCode) {
                window.localStorage.removeItem(PENDING_INVITE_KEY);
                const accepted = await tryAcceptInvite(pendingCode, currentSession.user.id);
                if (accepted) {
                    nextFriendships = [...nextFriendships, { user_id: currentSession.user.id, friend_id: accepted.ownerId }];
                    router.replace(`/people/${accepted.ownerId}`);
                }
            }
            setLiveFriendships(nextFriendships);
            setAuthLoading(false);
        };

        void loadSession();

        const subscription = supabase.auth.onAuthStateChange((event, currentSession) => {
            setSession(currentSession);
            if (event === "PASSWORD_RECOVERY") {
                setAuthView("recovery");
            }
            if (currentSession) {
                void loadSession();
            } else {
                setAuthLoading(false);
                setLiveProfiles([]);
                setLiveIdeas([]);
                setLiveFriendships([]);
                setLiveFriendRequests([]);
                setMyReservations([]);
                setLiveGroups([]);
                setLiveGroupMembers([]);
                setLiveIdeaVisibility([]);
                setLiveNotifications([]);
                setLiveIdeaSuggestions([]);
                setLiveGiftPlans([]);
                setLiveGiftPlanParticipants([]);
                setLiveOccasions([]);
                setLivePolls([]);
                setLivePollOptions([]);
                setLivePollVotes([]);
                setChatMessages([]);
            }
        });

        return () => {
            subscription.data.subscription.unsubscribe();
        };
    }, []);

    const effectiveMe = useMemo(() => {
        if (session && liveProfiles.length > 0) {
            const profile = liveProfiles.find((row) => row.id === session.user.id);
            if (profile) {
                return {
                    id: profile.id,
                    name: profile.full_name,
                    avatar: profile.avatar_url,
                    birthday: profile.birthday ?? mockMe.birthday,
                    birthdayIn: 0,
                    relation: "Ja",
                    groups: ["rodzina"],
                    city: profile.city ?? mockMe.city,
                } as Person;
            }
        }

        return {
            id: mockMe.id,
            name: mockMe.name,
            avatar: null,
            birthday: mockMe.birthday,
            birthdayIn: 0,
            relation: "Ja",
            groups: ["rodzina"],
            city: mockMe.city,
        } as Person;
    }, [liveProfiles, session]);

    const effectivePeople = useMemo(() => {
        if (session && liveProfiles.length > 0) {
            const friendIds = new Set(
                liveFriendships
                    .filter((row) => row.user_id === session.user.id || row.friend_id === session.user.id)
                    .map((row) => (row.user_id === session.user.id ? row.friend_id : row.user_id))
            );
            return liveProfiles
                .filter((profile) => friendIds.has(profile.id))
                .map((profile) => ({
                    id: profile.id,
                    name: profile.full_name,
                    avatar: profile.avatar_url,
                    birthday: profile.birthday ?? "brak daty",
                    birthdayIn: 30,
                    relation: "Znajomy",
                    groups: ["znajomi"],
                })) as Person[];
        }
        return [];
    }, [liveProfiles, liveFriendships, session]);

    const pendingIncomingRequests = useMemo(() => {
        if (!session) return [];
        return liveFriendRequests
            .filter((row) => row.recipient_id === session.user.id)
            .map((row) => {
                const sender = liveProfiles.find((profile) => profile.id === row.sender_id);
                return { requestId: row.id, id: row.sender_id, name: sender?.full_name ?? "Ktoś", avatar: sender?.avatar_url ?? null };
            });
    }, [liveFriendRequests, liveProfiles, session]);

    const pendingOutgoingRequests = useMemo(() => {
        if (!session) return [];
        return liveFriendRequests
            .filter((row) => row.sender_id === session.user.id)
            .map((row) => {
                const recipient = liveProfiles.find((profile) => profile.id === row.recipient_id);
                return { requestId: row.id, id: row.recipient_id, name: recipient?.full_name ?? "Ktoś", avatar: recipient?.avatar_url ?? null };
            });
    }, [liveFriendRequests, liveProfiles, session]);

    const incomingSuggestions = useMemo(() => {
        if (!session) return [];
        return liveIdeaSuggestions
            .filter((row) => row.recipient_id === session.user.id && row.status === "pending")
            .map((row) => {
                const sender = liveProfiles.find((profile) => profile.id === row.sender_id);
                return { ...row, senderName: sender?.full_name ?? "Ktoś" };
            });
    }, [liveIdeaSuggestions, liveProfiles, session]);

    const outgoingSuggestions = useMemo(() => {
        if (!session) return [];
        return liveIdeaSuggestions
            .filter((row) => row.sender_id === session.user.id)
            .map((row) => {
                const recipient = liveProfiles.find((profile) => profile.id === row.recipient_id);
                return { ...row, recipientName: recipient?.full_name ?? "Ktoś" };
            });
    }, [liveIdeaSuggestions, liveProfiles, session]);

    // Kandydaci do wyszukania na ekranie "Dodaj znajomego": wszyscy użytkownicy
    // appki poza sobą i już-znajomymi (effectivePeople), z informacją o
    // ewentualnym zaproszeniu, które już krąży między nami w dowolną stronę.
    const friendSearchCandidates = useMemo(() => {
        if (!session) return [];
        const friendIds = new Set(effectivePeople.map((person) => person.id));
        const outgoingIds = new Set(pendingOutgoingRequests.map((request) => request.id));
        const incomingByPersonId = new Map(pendingIncomingRequests.map((request) => [request.id, request.requestId]));
        return liveProfiles
            .filter((profile) => profile.id !== session.user.id && !friendIds.has(profile.id))
            .map((profile) => ({
                id: profile.id,
                name: profile.full_name,
                avatar: profile.avatar_url,
                status: incomingByPersonId.has(profile.id)
                    ? ("incoming" as const)
                    : outgoingIds.has(profile.id)
                      ? ("outgoing" as const)
                      : ("none" as const),
                incomingRequestId: incomingByPersonId.get(profile.id) ?? null,
            }));
    }, [liveProfiles, effectivePeople, pendingOutgoingRequests, pendingIncomingRequests, session]);

    const toIdea = (row: GiftIdeaRow): Idea => ({
        id: row.id,
        ownerId: row.user_id,
        title: row.title,
        note: row.description ?? "Brak opisu.",
        url: row.url ?? undefined,
        price: row.price ?? null,
        store: row.store || (row.url ? guessStoreFromUrl(row.url) : "") || "Sklep",
        image: row.image_url,
        priority: (row.priority ?? "chce") as Priority,
        visibility: liveIdeaVisibility.filter((v) => v.idea_id === row.id).map((v) => v.group_id),
        visibleToAll: Boolean(row.visible_to_all),
        favorite: Boolean(row.favorite),
        addedAt: row.created_at ? new Date(row.created_at).toLocaleDateString("pl-PL") : "nowo",
        status: row.status === "archived" ? "archived" : "active",
        archivedAt: row.archived_at ? new Date(row.archived_at).toLocaleDateString("pl-PL") : undefined,
    });

    // Moje plany wspólnej organizacji (ETAP 17) — łączymy gift_plans z moim
    // wierszem w gift_plan_participants (RLS i tak zwraca tylko plany, w
    // których jestem uczestnikiem, więc find() zawsze coś znajdzie).
    const myGiftPlans = useMemo(() => {
        if (!session) return [];
        return liveGiftPlans
            .map((plan) => {
                const myParticipation = liveGiftPlanParticipants.find(
                    (row) => row.gift_plan_id === plan.id && row.user_id === session.user.id
                );
                const ideaRow = liveIdeas.find((idea) => idea.id === plan.idea_id);
                if (!myParticipation || !ideaRow) return null;
                return { plan, myStatus: myParticipation.status, idea: toIdea(ideaRow) };
            })
            .filter((row): row is { plan: GiftPlanRow; myStatus: GiftPlanParticipantStatus; idea: Idea } => row !== null);
    }, [liveGiftPlans, liveGiftPlanParticipants, liveIdeas, liveIdeaVisibility, session]);

    const pendingGiftPlanInvitesCount = useMemo(
        () => myGiftPlans.filter((row) => row.myStatus === "invited").length,
        [myGiftPlans]
    );

    const selectedGiftPlan = useMemo(() => {
        if (!routeGiftPlanId) return null;
        return myGiftPlans.find((row) => row.plan.id === routeGiftPlanId) ?? null;
    }, [myGiftPlans, routeGiftPlanId]);

    const selectedGiftPlanParticipants = useMemo(() => {
        if (!routeGiftPlanId) return [];
        return liveGiftPlanParticipants
            .filter((row) => row.gift_plan_id === routeGiftPlanId)
            .map((row) => {
                const profile = liveProfiles.find((p) => p.id === row.user_id);
                return { userId: row.user_id, name: profile?.full_name ?? "Ktoś", avatar: profile?.avatar_url ?? null, status: row.status };
            });
    }, [liveGiftPlanParticipants, liveProfiles, routeGiftPlanId]);

    // ETAP 8 — każda okazja traktowana jako coroczna: liczymy najbliższe
    // wystąpienie miesiąca/dnia z occasion_date, licząc od dziś (jeśli już
    // minęło w tym roku, bierzemy przyszły rok).
    const daysUntilNextOccurrence = (occasionDate: string): number => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const [, month, day] = occasionDate.split("-").map(Number);
        let next = new Date(today.getFullYear(), month - 1, day);
        if (next < today) next = new Date(today.getFullYear() + 1, month - 1, day);
        return Math.round((next.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    };

    const myOccasions = useMemo(() => {
        if (!session) return [];
        return liveOccasions
            .filter((row) => row.owner_id === session.user.id)
            .map((row) => ({ ...row, daysUntil: daysUntilNextOccurrence(row.occasion_date) }))
            .sort((a, b) => a.daysUntil - b.daysUntil);
    }, [liveOccasions, session]);

    const upcomingFriendOccasions = useMemo(() => {
        if (!session) return [];
        return liveOccasions
            .filter((row) => row.owner_id !== session.user.id)
            .map((row) => {
                const owner = liveProfiles.find((profile) => profile.id === row.owner_id);
                return { ...row, ownerName: owner?.full_name ?? "Ktoś", daysUntil: daysUntilNextOccurrence(row.occasion_date) };
            })
            .sort((a, b) => a.daysUntil - b.daysUntil);
    }, [liveOccasions, liveProfiles, session]);

    // ETAP 19 — ankiety widoczne dla mnie, z rozwiązanymi opcjami i głosami
    // (RLS już przefiltrował livePolls/livePollOptions/livePollVotes do tego,
    // co faktycznie wolno mi zobaczyć — tu tylko składamy to w jedną strukturę).
    const myVisiblePolls = useMemo(() => {
        if (!session) return [];
        return livePolls
            .map((poll) => {
                const target = liveProfiles.find((profile) => profile.id === poll.target_id);
                const options = livePollOptions
                    .filter((option) => option.poll_id === poll.id)
                    .map((option) => ({
                        ...option,
                        voteCount: livePollVotes.filter((vote) => vote.poll_id === poll.id && vote.option_id === option.id).length,
                    }));
                const myVote = livePollVotes.find((vote) => vote.poll_id === poll.id && vote.user_id === session.user.id);
                return {
                    poll,
                    targetName: target?.full_name ?? "Ktoś",
                    options,
                    myOptionId: myVote?.option_id ?? null,
                };
            })
            .sort((a, b) => (a.poll.created_at < b.poll.created_at ? 1 : -1));
    }, [livePolls, livePollOptions, livePollVotes, liveProfiles, session]);

    const selectedPoll = useMemo(() => {
        if (!routePollId) return null;
        return myVisiblePolls.find((row) => row.poll.id === routePollId) ?? null;
    }, [myVisiblePolls, routePollId]);

    const effectiveMyIdeas = useMemo(() => {
        if (!session) return [];
        return liveIdeas.filter((idea) => idea.user_id === session.user.id && idea.status !== "archived").map(toIdea);
    }, [liveIdeas, liveIdeaVisibility, session]);

    const myArchivedIdeas = useMemo(() => {
        if (!session) return [];
        return liveIdeas.filter((idea) => idea.user_id === session.user.id && idea.status === "archived").map(toIdea);
    }, [liveIdeas, liveIdeaVisibility, session]);

    const effectiveFriendIdeas = useMemo(() => {
        if (!session) return {};
        const byUser: Record<string, Idea[]> = {};
        effectivePeople.forEach((person) => {
            byUser[person.id] = liveIdeas.filter((idea) => idea.user_id === person.id && idea.status !== "archived").map(toIdea);
        });
        return byUser;
    }, [liveIdeas, liveIdeaVisibility, effectivePeople, session]);

    const ideas = effectiveMyIdeas;

    const myReservedIdeas = useMemo(() => {
        return myReservations
            .filter((reservation) => reservation.status === "reserved" || reservation.status === "purchased")
            .map((reservation) => {
                const ideaRow = liveIdeas.find((idea) => idea.id === reservation.idea_id);
                if (!ideaRow) return null;
                const owner = liveProfiles.find((profile) => profile.id === ideaRow.user_id);
                return {
                    reservationId: reservation.id,
                    reservationStatus: reservation.status,
                    idea: toIdea(ideaRow),
                    ownerName: owner?.full_name ?? "Nieznajomy",
                };
            })
            .filter(
                (row): row is { reservationId: string; reservationStatus: ReservationKind; idea: Idea; ownerName: string } =>
                    row !== null
            );
    }, [myReservations, liveIdeas, liveIdeaVisibility, liveProfiles]);

    const myReservationByIdeaId = useMemo(() => {
        const map = new Map<string, ReservationRow>();
        myReservations.forEach((reservation) => {
            if (reservation.status === "reserved" || reservation.status === "purchased") {
                map.set(reservation.idea_id, reservation);
            }
        });
        return map;
    }, [myReservations]);

    const unreadNotificationsCount = useMemo(
        () => liveNotifications.filter((notification) => !notification.read).length,
        [liveNotifications]
    );

    type MyGroup = {
        id: string;
        name: string;
        description: string;
        isOwner: boolean;
        reservationsEnabled: boolean;
        members: Person[];
    };

    const myGroups = useMemo<MyGroup[]>(() => {
        if (!session) return [];
        return liveGroups
            .filter((group) =>
                group.owner_id === session.user.id ||
                liveGroupMembers.some((row) => row.group_id === group.id && row.user_id === session.user.id)
            )
            .map((group) => {
                const memberIds = liveGroupMembers.filter((row) => row.group_id === group.id).map((row) => row.user_id);
                const members = liveProfiles
                    .filter((profile) => memberIds.includes(profile.id))
                    .map((profile) =>
                        profile.id === effectiveMe.id
                            ? effectiveMe
                            : effectivePeople.find((person) => person.id === profile.id) ?? {
                                  id: profile.id,
                                  name: profile.full_name,
                                  avatar: profile.avatar_url,
                                  birthday: profile.birthday ?? "brak daty",
                                  birthdayIn: 0,
                                  relation: "Znajomy",
                                  groups: [] as string[],
                              }
                    );
                return {
                    id: group.id,
                    name: group.name,
                    description: group.description ?? "",
                    isOwner: group.owner_id === session.user.id,
                    reservationsEnabled: group.reservations_enabled,
                    members,
                };
            });
    }, [session, liveGroups, liveGroupMembers, liveProfiles, effectiveMe, effectivePeople]);

    const groupNameById = useMemo(
        () => Object.fromEntries(myGroups.map((group) => [group.id, group.name])),
        [myGroups]
    );

    const selectedFriendId = routeFriendId ?? effectiveMe.id;
    const selectedFriend =
        selectedFriendId === effectiveMe.id
            ? effectiveMe
            : effectivePeople.find((person) => person.id === selectedFriendId) ?? effectiveMe;

    const visibleIdeas = useMemo(() => {
        if (activeFilter === "ulubione") {
            return ideas.filter((idea) => idea.favorite);
        }
        if (activeFilter === "wszystkie") {
            return ideas;
        }
        return ideas.filter((idea) => idea.priority === activeFilter);
    }, [activeFilter, ideas]);

    const friendVisibleIdeas = useMemo(() => {
        const source = effectiveFriendIdeas[selectedFriend.id] ?? [];
        if (friendListFilter === "wszystkie") {
            return source;
        }
        return source.filter((idea) => idea.priority === friendListFilter);
    }, [effectiveFriendIdeas, selectedFriend.id, friendListFilter]);

    const selectedIdea = useMemo(() => {
        if (!routeIdeaId) return null;
        if (detailOwner === "friend") {
            const source = effectiveFriendIdeas[selectedFriend.id] ?? [];
            return source.find((idea) => idea.id === routeIdeaId) ?? null;
        }
        return (
            ideas.find((idea) => idea.id === routeIdeaId) ??
            myArchivedIdeas.find((idea) => idea.id === routeIdeaId) ??
            null
        );
    }, [detailOwner, effectiveFriendIdeas, ideas, myArchivedIdeas, selectedFriend.id, routeIdeaId]);

    // Wartości startowe formularza liczone wprost z renderu (bez efektu): dla
    // edycji szukamy pomysłu po id z URL, w przeciwnym razie pusty draft.
    // AddIdeaScreen dostaje je jako initialValues i trzyma własny stan,
    // resetowany przez zmianę `key` (editingIdeaId), nigdy przez setState w efekcie.
    const addIdeaInitialValues: NewIdeaForm = useMemo(() => {
        const idea = editingIdeaId ? ideas.find((item) => item.id === editingIdeaId) : null;
        if (idea) {
            return {
                title: idea.title,
                url: idea.url ?? "",
                price: idea.price != null ? String(idea.price) : "",
                store: idea.store,
                comment: idea.note,
                priority: idea.priority,
                visibility: idea.visibility,
                visibleToAll: idea.visibleToAll,
                imageUrl: idea.image,
                imageFile: null,
            };
        }
        return {
            title: "",
            url: "",
            price: "",
            store: "",
            comment: "",
            priority: "chce",
            visibility: [],
            visibleToAll: false,
            imageUrl: null,
            imageFile: null,
        };
    }, [editingIdeaId, ideas]);

    const goToIdeas = () => router.replace("/");
    const goToAddIdea = () => router.push("/add");
    // replace (nie push!) — edycja zajmuje TEN SAM slot w historii co widok
    // szczegółów, zamiast dokładać nowy wpis. Dzięki temu zapis (który wraca
    // na "/ideas/{id}") nigdy nie tworzy dwóch kolejnych wpisów z identycznym
    // URL-em — a to właśnie powodowało, że pierwsze kliknięcie "Wróć" po
    // edycji nic nie robiło (patrz submitIdea).
    const goToEditIdea = (ideaId: string) => router.replace(`/ideas/${ideaId}/edit`);
    const goToIdeaDetail = (ideaId: string) => router.push(`/ideas/${ideaId}`);
    const goToPeople = () => router.replace("/people");
    const goToAddFriend = () => router.push("/people/add");
    const goToFriendRequests = () => router.push("/people/requests");
    const goToPersonProfile = (personId: string) => router.push(`/people/${personId}`);
    const goToPersonIdeas = (personId: string) => router.push(`/people/${personId}/ideas`);
    const goToFriendIdeaDetail = (personId: string, ideaId: string) => router.push(`/people/${personId}/ideas/${ideaId}`);
    const goToGifts = () => router.replace("/gifts");
    const goToProfile = () => router.replace("/profile");
    const goToEditProfile = () => router.push("/profile/edit");
    const goToPrivacy = () => router.push("/privacy");
    const goToArchive = () => router.push("/archive");
    const goToNotifications = () => router.push("/notifications");
    const goToSuggestIdea = (friendId: string) => router.push(`/people/${friendId}/suggest`);
    const goToGiftPlans = () => router.push("/gift-plans");
    const goToGiftPlan = (planId: string) => router.push(`/gift-plans/${planId}`);
    const goToOccasions = () => router.push("/occasions");
    const goToCreatePoll = (friendId: string) => router.push(`/people/${friendId}/poll`);
    const goToPolls = () => router.push("/polls");
    const goToPoll = (pollId: string) => router.push(`/polls/${pollId}`);

    const submitIdea = async (values: NewIdeaForm) => {
        if (!values.title.trim() || !session) return;
        setIdeaActionError("");

        let imageUrl = values.imageUrl;
        if (values.imageFile) {
            const compressed = await compressImageFile(values.imageFile);
            const extension = compressed.name.split(".").pop() ?? "jpg";
            const path = `${session.user.id}/${crypto.randomUUID()}.${extension}`;
            const { error: uploadError } = await supabase.storage
                .from("idea-images")
                .upload(path, compressed, { upsert: true, contentType: compressed.type });
            if (uploadError) {
                setIdeaActionError(uploadError.message);
                return;
            }
            const { data: publicUrlData } = supabase.storage.from("idea-images").getPublicUrl(path);
            imageUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`;
        }

        const payload = {
            title: values.title.trim(),
            description: values.comment || null,
            url: values.url || null,
            store: values.store || null,
            price: values.price ? Number(values.price) : null,
            priority: values.priority,
            visible_to_all: values.visibleToAll,
            image_url: imageUrl,
        };

        const query = editingIdeaId
            ? supabase.from("gift_ideas").update(payload).eq("id", editingIdeaId).select().single()
            : supabase.from("gift_ideas").insert({ ...payload, user_id: session.user.id }).select().single();

        const { data, error } = await query;

        if (error || !data) {
            setIdeaActionError(error?.message ?? "Nie udało się zapisać pomysłu.");
            return;
        }

        const ideaId: string = data.id;

        if (editingIdeaId) {
            await supabase.from("idea_visibility").delete().eq("idea_id", ideaId);
        }
        if (values.visibility.length > 0) {
            const { error: visibilityError } = await supabase
                .from("idea_visibility")
                .insert(values.visibility.map((groupId) => ({ idea_id: ideaId, group_id: groupId })));
            if (visibilityError) {
                setIdeaActionError(visibilityError.message);
                return;
            }
        }

        setLiveIdeas((prev) => (editingIdeaId ? prev.map((row) => (row.id === editingIdeaId ? data : row)) : [data, ...prev]));
        setLiveIdeaVisibility((prev) => [
            ...prev.filter((v) => v.idea_id !== ideaId),
            ...values.visibility.map((groupId) => ({ idea_id: ideaId, group_id: groupId })),
        ]);

        // goToEditIdea wchodzi w edycję przez router.replace (nie push), więc
        // ten replace na "/ideas/{id}" nigdy nie tworzy dwóch kolejnych wpisów
        // historii z identycznym URL-em — bez względu na to, czy edytujemy
        // istniejący pomysł, czy właśnie utworzyliśmy nowy.
        router.replace(`/ideas/${ideaId}`);
    };

    const deleteIdea = async (ideaId: string) => {
        const { error } = await supabase.from("gift_ideas").delete().eq("id", ideaId);
        if (error) {
            setIdeaActionError(error.message);
            return;
        }
        setLiveIdeas((prev) => prev.filter((row) => row.id !== ideaId));
        setLiveIdeaVisibility((prev) => prev.filter((v) => v.idea_id !== ideaId));
        router.replace("/");
    };

    // Realtime dla dzwoneczka powiadomień i zaproszeń — bez tego trzeba by
    // było odświeżać stronę, żeby zobaczyć coś nowego. AppShell nigdy się nie
    // odmontowuje (patrz architektura w CLAUDE.md), więc jeden kanał na całą
    // sesję wystarczy; subskrybujemy ponownie tylko przy zmianie użytkownika.
    useEffect(() => {
        if (!session) return;
        const userId = session.user.id;

        const channel = supabase
            .channel(`notifications-${userId}`)
            .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "notifications", filter: `recipient_id=eq.${userId}` },
                (payload) => {
                    setLiveNotifications((prev) => [payload.new as NotificationRow, ...prev]);
                }
            )
            .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "friend_requests", filter: `recipient_id=eq.${userId}` },
                (payload) => {
                    setLiveFriendRequests((prev) => [...prev, payload.new as FriendRequestRow]);
                }
            )
            .on(
                "postgres_changes",
                { event: "DELETE", schema: "public", table: "friend_requests" },
                (payload) => {
                    const deletedId = (payload.old as { id?: string }).id;
                    if (deletedId) setLiveFriendRequests((prev) => prev.filter((row) => row.id !== deletedId));
                }
            )
            // "Podrzuć pomysł" — bez tego nowa sugestia trafiała do notifications
            // (ma tam realtime), ale sam wiersz w idea_suggestions czekał na
            // odświeżenie sesji, więc zakładka "Sugestie" wyglądała na pustą.
            .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "idea_suggestions" },
                (payload) => {
                    setLiveIdeaSuggestions((prev) => [payload.new as IdeaSuggestionRow, ...prev]);
                }
            )
            .on(
                "postgres_changes",
                { event: "UPDATE", schema: "public", table: "idea_suggestions" },
                (payload) => {
                    const updated = payload.new as IdeaSuggestionRow;
                    setLiveIdeaSuggestions((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
                }
            )
            // Zaproszenie do "Wspólnego prezentu": wiersz w gift_plan_participants
            // to jedyny moment, w którym zaproszony w ogóle staje się uprawniony do
            // zobaczenia planu (RLS), więc samo dodanie tabeli do publikacji nie
            // wystarczy — plan i pomysł trzeba dociągnąć osobnym zapytaniem,
            // bo ich insert zdarzył się, zanim zaproszony miał do nich dostęp.
            .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "gift_plan_participants" },
                (payload) => {
                    const participant = payload.new as GiftPlanParticipantRow;
                    setLiveGiftPlanParticipants((prev) =>
                        prev.some((row) => row.gift_plan_id === participant.gift_plan_id && row.user_id === participant.user_id)
                            ? prev
                            : [...prev, participant]
                    );
                    void (async () => {
                        const { data: plan } = await supabase.from("gift_plans").select("*").eq("id", participant.gift_plan_id).single();
                        if (!plan) return;
                        setLiveGiftPlans((prev) => (prev.some((row) => row.id === plan.id) ? prev : [...prev, plan as GiftPlanRow]));
                        const { data: idea } = await supabase.from("gift_ideas").select("*").eq("id", plan.idea_id).single();
                        if (idea) setLiveIdeas((prev) => (prev.some((row) => row.id === idea.id) ? prev : [...prev, idea as GiftIdeaRow]));
                    })();
                }
            )
            .on(
                "postgres_changes",
                { event: "UPDATE", schema: "public", table: "gift_plan_participants" },
                (payload) => {
                    const updated = payload.new as GiftPlanParticipantRow;
                    setLiveGiftPlanParticipants((prev) =>
                        prev.map((row) =>
                            row.gift_plan_id === updated.gift_plan_id && row.user_id === updated.user_id ? updated : row
                        )
                    );
                }
            )
            // Ankiety: znajomi targetu kwalifikują się do zobaczenia ankiety już w
            // momencie jej stworzenia (RLS zależy tylko od istniejącej znajomości),
            // więc w przeciwieństwie do wspólnych prezentów zwykła subskrypcja
            // insertu wystarcza — bez dodatkowego dociągania.
            .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "polls" },
                (payload) => {
                    const poll = payload.new as PollRow;
                    setLivePolls((prev) => (prev.some((row) => row.id === poll.id) ? prev : [...prev, poll]));
                }
            )
            .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "poll_options" },
                (payload) => {
                    const option = payload.new as PollOptionRow;
                    setLivePollOptions((prev) => (prev.some((row) => row.id === option.id) ? prev : [...prev, option]));
                }
            )
            .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "poll_votes" },
                (payload) => {
                    const vote = payload.new as PollVoteRow;
                    setLivePollVotes((prev) =>
                        prev.some((row) => row.poll_id === vote.poll_id && row.user_id === vote.user_id) ? prev : [...prev, vote]
                    );
                }
            )
            .on(
                "postgres_changes",
                { event: "UPDATE", schema: "public", table: "poll_votes" },
                (payload) => {
                    const updated = payload.new as PollVoteRow;
                    setLivePollVotes((prev) =>
                        prev.map((row) => (row.poll_id === updated.poll_id && row.user_id === updated.user_id ? updated : row))
                    );
                }
            )
            .subscribe();

        return () => {
            void supabase.removeChannel(channel);
        };
    }, [session?.user.id]);

    useEffect(() => {
        if (!session || friendVisibleIdeas.length === 0) return;
        let cancelled = false;

        (async () => {
            const entries = await Promise.all(
                friendVisibleIdeas.map(async (idea) => {
                    const [reservedRes, byMeRes] = await Promise.all([
                        supabase.rpc("is_idea_reserved", { p_idea_id: idea.id }),
                        supabase.rpc("is_idea_reserved_by_me", { p_idea_id: idea.id }),
                    ]);
                    return [idea.id, { reserved: Boolean(reservedRes.data), byMe: Boolean(byMeRes.data) }] as const;
                })
            );

            if (!cancelled) {
                setReservationStatus((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [friendVisibleIdeas, session]);

    // Link zaproszenia pobieramy/tworzymy dopiero na ekranie "Dodaj znajomego" —
    // nie ma sensu robić tego przy każdym starcie sesji, skoro rzadko tam się wchodzi.
    useEffect(() => {
        if (!session || screen !== "add-friend" || myInvite) return;
        let cancelled = false;

        (async () => {
            const { data: existing } = await supabase
                .from("friend_invites")
                .select("id")
                .eq("owner_id", session.user.id)
                .eq("active", true)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (cancelled) return;
            if (existing) {
                setMyInvite(existing);
                return;
            }

            const { data: created } = await supabase
                .from("friend_invites")
                .insert({ owner_id: session.user.id })
                .select("id")
                .single();

            if (!cancelled && created) setMyInvite(created);
        })();

        return () => {
            cancelled = true;
        };
    }, [session, screen, myInvite]);

    const toggleGroupReservations = async (groupId: string, next: boolean) => {
        const { error } = await supabase.from("idea_groups").update({ reservations_enabled: next }).eq("id", groupId);
        if (error) {
            setIdeaActionError(error.message);
            return;
        }
        setLiveGroups((prev) => prev.map((group) => (group.id === groupId ? { ...group, reservations_enabled: next } : group)));
    };

    const toggleGlobalReservations = async (next: boolean) => {
        if (!session) return;
        const { error } = await supabase.from("profiles").update({ reservations_enabled: next }).eq("id", session.user.id);
        if (error) {
            setIdeaActionError(error.message);
            return;
        }
        setLiveProfiles((prev) =>
            prev.map((profile) => (profile.id === session.user.id ? { ...profile, reservations_enabled: next } : profile))
        );
    };

    // Rezerwacja jest dozwolona, jeśli pomysł jest widoczny (dla mnie) przez
    // przynajmniej jedną wspólną grupę, która ma włączone rezerwacje, albo
    // jeśli pomysł jest udostępniony "Wszystkim znajomym" — ta kategoria nie
    // ma żadnej grupy do sprawdzenia, więc rezerwacje są tam zawsze dozwolone
    // (dokładnie tak samo jak w polityce RLS gift_reservations_insert_not_owner).
    const selectedIdeaOwnerAllowsReservations = useMemo(() => {
        if (detailOwner !== "friend" || !selectedIdea) return true;
        const ownerProfile = liveProfiles.find((profile) => profile.id === selectedIdea.ownerId);
        if (ownerProfile && !ownerProfile.reservations_enabled) return false;
        if (selectedIdea.visibleToAll) return true;
        const myGroupIds = new Set(myGroups.map((group) => group.id));
        return selectedIdea.visibility
            .filter((groupId) => myGroupIds.has(groupId))
            .some((groupId) => myGroups.find((group) => group.id === groupId)?.reservationsEnabled);
    }, [detailOwner, selectedIdea, myGroups, liveProfiles]);

    const onReserve = async () => {
        if (!session || !selectedIdea) return;
        setIdeaActionError("");

        const { data, error } = await supabase
            .from("gift_reservations")
            .insert({ idea_id: selectedIdea.id, reserved_by: session.user.id })
            .select("id, idea_id, status, created_at")
            .single();

        if (error || !data) {
            setIdeaActionError(
                error?.message.includes("RESERVATION_LIMIT_REACHED")
                    ? "Osiągnięto limit aktywnych rezerwacji dla tej osoby."
                    : "Nie udało się zarezerwować — ktoś mógł Cię wyprzedzić."
            );
            return;
        }

        setReservationStatus((prev) => ({ ...prev, [selectedIdea.id]: { reserved: true, byMe: true } }));
        setMyReservations((prev) => [...prev, data]);
    };

    const onMarkPurchased = async (reservationId: string) => {
        setIdeaActionError("");
        const { error } = await supabase.from("gift_reservations").update({ status: "purchased" }).eq("id", reservationId);
        if (error) {
            setIdeaActionError(error.message);
            return;
        }
        setMyReservations((prev) => prev.map((row) => (row.id === reservationId ? { ...row, status: "purchased" } : row)));
    };

    const onCancelReservation = async (reservationId: string, wasPurchased: boolean) => {
        if (wasPurchased) {
            const confirmed = await askConfirm({
                title: "Anulować rezerwację?",
                message: "Ten pomysł jest już oznaczony jako kupiony. Na pewno chcesz anulować rezerwację?",
                confirmLabel: "Anuluj rezerwację",
                cancelLabel: "Nie",
                danger: true,
            });
            if (!confirmed) return;
        }
        setIdeaActionError("");
        const { error } = await supabase.from("gift_reservations").update({ status: "cancelled" }).eq("id", reservationId);
        if (error) {
            setIdeaActionError(error.message);
            return;
        }
        setMyReservations((prev) => prev.map((row) => (row.id === reservationId ? { ...row, status: "cancelled" } : row)));
        if (selectedIdea) {
            setReservationStatus((prev) => ({ ...prev, [selectedIdea.id]: { reserved: false, byMe: false } }));
        }
    };

    const onMarkReceived = async (ideaId: string) => {
        const confirmedReceived = await askConfirm({
            title: "Dostałeś ten prezent?",
            message: "Po oznaczeniu pomysł zostanie przeniesiony do archiwum.",
            confirmLabel: "Dostałem ❤️",
            cancelLabel: "Anuluj",
        });
        if (!confirmedReceived) return;
        setIdeaActionError("");

        const { data: rawData, error } = await supabase.rpc("mark_idea_received", { p_idea_id: ideaId }).single();
        const data = rawData as { needs_confirmation: boolean } | null;
        if (error) {
            setIdeaActionError(error.message);
            return;
        }

        if (data?.needs_confirmation) {
            const confirmedSamePerson = await askConfirm({
                title: "Ten pomysł został oznaczony jako kupione przez jedną z osób.",
                message: "Czy dostałeś ten prezent właśnie od tej osoby?",
                confirmLabel: "Tak, to ten prezent ❤️",
                cancelLabel: "Nie / Nie wiem",
            });
            const { error: confirmError } = await supabase.rpc("mark_idea_received", {
                p_idea_id: ideaId,
                p_confirm_purchaser: confirmedSamePerson,
            });
            if (confirmError) {
                setIdeaActionError(confirmError.message);
                return;
            }
        }

        setLiveIdeas((prev) => prev.map((row) => (row.id === ideaId ? { ...row, status: "archived" as IdeaStatus } : row)));
        router.replace("/");
    };

    const markNotificationsRead = async () => {
        const unreadIds = liveNotifications.filter((n) => !n.read).map((n) => n.id);
        if (unreadIds.length === 0) return;
        await supabase.from("notifications").update({ read: true }).in("id", unreadIds);
        setLiveNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    };

    useEffect(() => {
        if (screen !== "notifications") return;
        void (async () => {
            await markNotificationsRead();
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [screen]);

    const onLogin = async () => {
        setAuthError("");
        setAuthInfo("");

        const email = loginForm.email.trim();
        const password = loginForm.password;

        if (!email || !password) {
            setAuthError("Wprowadź email i hasło.");
            return;
        }

        const { error } = await supabase.auth.signInWithPassword({
            email,
            password,
        });

        if (error) {
            setAuthError(error.message);
            return;
        }
    };

    const onRegister = async () => {
        setAuthError("");
        setAuthInfo("");

        const fullName = registerForm.fullName.trim();
        const email = registerForm.email.trim();
        const password = registerForm.password;

        if (!fullName || !email || !password) {
            setAuthError("Uzupełnij imię, email i hasło.");
            return;
        }

        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: { data: { full_name: fullName } },
        });

        if (error) {
            setAuthError(error.message);
            return;
        }

        if (!data.session) {
            setAuthInfo("Sprawdź skrzynkę e-mail, aby potwierdzić konto.");
            setAuthView("login");
        }
    };

    const onForgotPassword = async () => {
        setAuthError("");
        setAuthInfo("");

        const email = forgotEmail.trim();
        if (!email) {
            setAuthError("Podaj adres email.");
            return;
        }

        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: typeof window !== "undefined" ? window.location.origin : undefined,
        });

        if (error) {
            setAuthError(error.message);
            return;
        }

        setAuthInfo("Wysłaliśmy link do resetu hasła na podany adres.");
        setAuthView("login");
    };

    const onSetNewPassword = async () => {
        setAuthError("");
        setAuthInfo("");

        if (recoveryPassword.length < 6) {
            setAuthError("Hasło musi mieć co najmniej 6 znaków.");
            return;
        }

        const { error } = await supabase.auth.updateUser({ password: recoveryPassword });

        if (error) {
            setAuthError(error.message);
            return;
        }

        setRecoveryPassword("");
        setAuthInfo("Hasło zostało zmienione.");
        setAuthView("login");
    };

    const onLogout = async () => {
        await supabase.auth.signOut();
        router.replace("/");
    };

    const deleteAccount = async () => {
        if (!session) return;
        setIdeaActionError("");

        const response = await fetch("/api/delete-account", {
            method: "POST",
            headers: { Authorization: `Bearer ${session.access_token}` },
        });

        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            setIdeaActionError(body.error ?? "Nie udało się usunąć konta.");
            return;
        }

        await supabase.auth.signOut();
        router.replace("/");
    };

    const completeOnboarding = async () => {
        if (!session) return;
        const { error } = await supabase.from("profiles").update({ has_onboarded: true }).eq("id", session.user.id);
        if (error) {
            setIdeaActionError(error.message);
            return;
        }
        setLiveProfiles((prev) =>
            prev.map((profile) => (profile.id === session.user.id ? { ...profile, has_onboarded: true } : profile))
        );
    };

    const updateProfileFields = async (values: { fullName: string; city: string; birthday: string }) => {
        if (!session || !values.fullName.trim()) return;
        setIdeaActionError("");
        setProfileInfo("");

        const { error } = await supabase
            .from("profiles")
            .update({
                full_name: values.fullName.trim(),
                city: values.city || null,
                birthday: values.birthday || null,
            })
            .eq("id", session.user.id);

        if (error) {
            setIdeaActionError(error.message);
            return;
        }

        setLiveProfiles((prev) =>
            prev.map((profile) =>
                profile.id === session.user.id
                    ? { ...profile, full_name: values.fullName.trim(), city: values.city || null, birthday: values.birthday || null }
                    : profile
            )
        );
        setProfileInfo("Zapisano zmiany.");
    };

    const uploadAvatar = async (file: File) => {
        if (!session) return;
        setIdeaActionError("");
        setProfileInfo("");

        const compressed = await compressImageFile(file);
        const extension = compressed.name.split(".").pop() ?? "jpg";
        const path = `${session.user.id}/avatar.${extension}`;

        const { error: uploadError } = await supabase.storage
            .from("avatars")
            .upload(path, compressed, { upsert: true, contentType: compressed.type });
        if (uploadError) {
            setIdeaActionError(uploadError.message);
            return;
        }

        const { data } = supabase.storage.from("avatars").getPublicUrl(path);
        const avatarUrl = `${data.publicUrl}?v=${Date.now()}`;

        const { error } = await supabase.from("profiles").update({ avatar_url: avatarUrl }).eq("id", session.user.id);
        if (error) {
            setIdeaActionError(error.message);
            return;
        }

        setLiveProfiles((prev) =>
            prev.map((profile) => (profile.id === session.user.id ? { ...profile, avatar_url: avatarUrl } : profile))
        );
        setProfileInfo("Zdjęcie zaktualizowane.");
    };

    const removeAvatar = async () => {
        if (!session) return;
        setIdeaActionError("");
        setProfileInfo("");

        const { error } = await supabase.from("profiles").update({ avatar_url: null }).eq("id", session.user.id);
        if (error) {
            setIdeaActionError(error.message);
            return;
        }

        setLiveProfiles((prev) =>
            prev.map((profile) => (profile.id === session.user.id ? { ...profile, avatar_url: null } : profile))
        );
        setProfileInfo("Wrócono do domyślnego awatara.");
    };

    const updateEmail = async (newEmail: string) => {
        if (!newEmail.trim()) return;
        setIdeaActionError("");
        setProfileInfo("");

        const { error } = await supabase.auth.updateUser({ email: newEmail.trim() });
        if (error) {
            setIdeaActionError(error.message);
            return;
        }

        setProfileInfo("Sprawdź skrzynkę e-mail (starą i nową), aby potwierdzić zmianę adresu.");
    };

    const updatePassword = async (newPassword: string) => {
        if (newPassword.length < 6) {
            setIdeaActionError("Hasło musi mieć co najmniej 6 znaków.");
            return;
        }
        setIdeaActionError("");
        setProfileInfo("");

        const { error } = await supabase.auth.updateUser({ password: newPassword });
        if (error) {
            setIdeaActionError(error.message);
            return;
        }

        setProfileInfo("Hasło zostało zmienione.");
    };

    const sendFriendRequest = async (personId: string) => {
        if (!session) return;
        const { data, error } = await supabase
            .from("friend_requests")
            .insert({ sender_id: session.user.id, recipient_id: personId })
            .select()
            .single();
        if (error || !data) {
            setIdeaActionError(error?.message ?? "Nie udało się wysłać zaproszenia.");
            return;
        }
        setLiveFriendRequests((prev) => [...prev, data]);
    };

    const cancelFriendRequest = async (requestId: string) => {
        const { error } = await supabase.from("friend_requests").delete().eq("id", requestId);
        if (error) {
            setIdeaActionError(error.message);
            return;
        }
        setLiveFriendRequests((prev) => prev.filter((row) => row.id !== requestId));
    };

    const acceptFriendRequest = async (requestId: string, senderId: string) => {
        if (!session) return;
        const { error } = await supabase.rpc("accept_friend_request", { p_request_id: requestId });
        if (error) {
            setIdeaActionError(error.message);
            return;
        }
        setLiveFriendships((prev) => [...prev, { user_id: session.user.id, friend_id: senderId }]);
        setLiveFriendRequests((prev) => prev.filter((row) => row.id !== requestId));
    };

    // ETAP PO MVP 15 — "Podrzuć pomysł": prosta sugestia znajomemu (zdjęcie/
    // nazwa/link), bez SECURITY DEFINER — insert może tylko nadawca (RLS
    // sprawdza znajomość), status zmienia tylko odbiorca.
    const sendIdeaSuggestion = async (recipientId: string, title: string, url: string, imageFile: File | null) => {
        if (!session || !title.trim()) return;
        setIdeaActionError("");

        let imageUrl: string | null = null;
        if (imageFile) {
            const compressed = await compressImageFile(imageFile);
            const extension = compressed.name.split(".").pop() ?? "jpg";
            const path = `${session.user.id}/suggestion-${crypto.randomUUID()}.${extension}`;
            const { error: uploadError } = await supabase.storage
                .from("idea-images")
                .upload(path, compressed, { upsert: true, contentType: compressed.type });
            if (uploadError) {
                setIdeaActionError(uploadError.message);
                return;
            }
            const { data: publicUrlData } = supabase.storage.from("idea-images").getPublicUrl(path);
            imageUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`;
        }

        const { data, error } = await supabase
            .from("idea_suggestions")
            .insert({ sender_id: session.user.id, recipient_id: recipientId, title: title.trim(), url: url || null, image_url: imageUrl })
            .select()
            .single();
        if (error || !data) {
            setIdeaActionError(error?.message ?? "Nie udało się wysłać sugestii.");
            return;
        }
        setLiveIdeaSuggestions((prev) => [data, ...prev]);
        router.replace(`/people/${recipientId}`);
    };

    const respondToSuggestion = async (suggestion: IdeaSuggestionRow, accept: boolean) => {
        if (!session) return;
        setIdeaActionError("");

        if (accept) {
            const { data: newIdea, error: insertError } = await supabase
                .from("gift_ideas")
                .insert({
                    user_id: session.user.id,
                    title: suggestion.title,
                    url: suggestion.url,
                    image_url: suggestion.image_url,
                    priority: "chce",
                })
                .select()
                .single();
            if (insertError || !newIdea) {
                setIdeaActionError(insertError?.message ?? "Nie udało się dodać pomysłu.");
                return;
            }
            setLiveIdeas((prev) => [newIdea, ...prev]);
        }

        const nextStatus: SuggestionStatus = accept ? "accepted" : "dismissed";
        const { error } = await supabase.from("idea_suggestions").update({ status: nextStatus }).eq("id", suggestion.id);
        if (error) {
            setIdeaActionError(error.message);
            return;
        }
        setLiveIdeaSuggestions((prev) => prev.map((row) => (row.id === suggestion.id ? { ...row, status: nextStatus } : row)));
    };

    // ETAP PO MVP 17 — "Wspólne prezenty": twórca/uczestnicy planu widzą tylko
    // TEN JEDEN pomysł (patrz idea_shared_via_gift_plan w schema.sql) —
    // właściciel pomysłu nigdy nie ma dostępu do gift_plans/participants.
    const createGiftPlan = async (ideaId: string) => {
        setIdeaActionError("");
        const { data: planId, error } = await supabase.rpc("create_gift_plan", { p_idea_id: ideaId });
        if (error || !planId) {
            setIdeaActionError(error?.message ?? "Nie udało się utworzyć wspólnej organizacji.");
            return;
        }
        if (session) {
            setLiveGiftPlans((prev) => [...prev, { id: planId, idea_id: ideaId, created_by: session.user.id, created_at: new Date().toISOString() }]);
            setLiveGiftPlanParticipants((prev) => [
                ...prev,
                { gift_plan_id: planId, user_id: session.user.id, status: "joined", created_at: new Date().toISOString() },
            ]);
        }
        goToGiftPlan(planId);
    };

    const inviteToGiftPlan = async (planId: string, userId: string) => {
        setIdeaActionError("");
        const { error } = await supabase.rpc("invite_to_gift_plan", { p_plan_id: planId, p_user_id: userId });
        if (error) {
            setIdeaActionError(error.message);
            return;
        }
        setLiveGiftPlanParticipants((prev) => [
            ...prev,
            { gift_plan_id: planId, user_id: userId, status: "invited", created_at: new Date().toISOString() },
        ]);
    };

    const respondToGiftPlanInvite = async (planId: string, accept: boolean) => {
        if (!session) return;
        setIdeaActionError("");
        const { error } = await supabase.rpc("respond_to_gift_plan_invite", { p_plan_id: planId, p_accept: accept });
        if (error) {
            setIdeaActionError(error.message);
            return;
        }
        const nextStatus: GiftPlanParticipantStatus = accept ? "joined" : "declined";
        setLiveGiftPlanParticipants((prev) =>
            prev.map((row) => (row.gift_plan_id === planId && row.user_id === session.user.id ? { ...row, status: nextStatus } : row))
        );
    };

    // ETAP 18 — Czat przypięty do gift planu. Wiadomości ładujemy leniwie
    // tylko dla aktualnie otwartego planu i dosubskrybowujemy Realtime na czas
    // trwania wizyty na tym ekranie — inaczej niż reszta stanu (wczytywana raz
    // przy starcie sesji), bo czat jest jedyną tabelą bez naturalnego limitu
    // wielkości.
    useEffect(() => {
        if (!routeGiftPlanId) return;
        let cancelled = false;

        void (async () => {
            const { data } = await supabase
                .from("chat_messages")
                .select("*")
                .eq("gift_plan_id", routeGiftPlanId)
                .order("created_at", { ascending: true });
            if (!cancelled && data) setChatMessages(data);
        })();

        const channel = supabase
            .channel(`chat-${routeGiftPlanId}`)
            .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "chat_messages", filter: `gift_plan_id=eq.${routeGiftPlanId}` },
                (payload) => {
                    setChatMessages((prev) => [...prev, payload.new as ChatMessageRow]);
                }
            )
            .subscribe();

        return () => {
            cancelled = true;
            setChatMessages([]);
            void supabase.removeChannel(channel);
        };
    }, [routeGiftPlanId]);

    const sendChatMessage = async (planId: string, message: string) => {
        if (!session || !message.trim()) return;
        setIdeaActionError("");
        const { error } = await supabase
            .from("chat_messages")
            .insert({ gift_plan_id: planId, sender_id: session.user.id, message: message.trim() });
        if (error) {
            setIdeaActionError(error.message);
            return;
        }
        // Nie dopisujemy lokalnie — wiadomość wróci przez subskrypcję Realtime
        // powyżej (nadawca też jest na niej), więc unikamy zdublowania wpisu.
        setChatDraft("");
    };

    // ETAP 8 — Okazje (urodziny i inne wydarzenia z prawdziwą datą).
    const addOccasion = async (name: string, occasionDate: string, groupId: string | null) => {
        if (!session || !name.trim() || !occasionDate) return;
        setIdeaActionError("");
        const { data, error } = await supabase
            .from("occasions")
            .insert({ owner_id: session.user.id, name: name.trim(), occasion_date: occasionDate, group_id: groupId })
            .select()
            .single();
        if (error || !data) {
            setIdeaActionError(error?.message ?? "Nie udało się dodać okazji.");
            return;
        }
        setLiveOccasions((prev) => [...prev, data]);
    };

    const deleteOccasion = async (occasionId: string) => {
        setIdeaActionError("");
        const { error } = await supabase.from("occasions").delete().eq("id", occasionId);
        if (error) {
            setIdeaActionError(error.message);
            return;
        }
        setLiveOccasions((prev) => prev.filter((row) => row.id !== occasionId));
    };

    // ETAP 19 — Ankiety. Właściciel prezentu (target) nigdy nie może być
    // tym, kto tworzy ankietę o samym sobie — wymuszone też w RLS (check
    // target_id <> created_by), ale sprawdzamy wcześniej po stronie klienta
    // dla lepszego komunikatu błędu.
    const createPoll = async (targetId: string, question: string, options: string[], groupId: string | null) => {
        if (!session || !question.trim()) return;
        const cleanOptions = options.map((option) => option.trim()).filter(Boolean);
        if (cleanOptions.length < 2) {
            setIdeaActionError("Dodaj przynajmniej dwie opcje.");
            return;
        }
        setIdeaActionError("");

        const { data: poll, error } = await supabase
            .from("polls")
            .insert({ target_id: targetId, created_by: session.user.id, question: question.trim(), group_id: groupId })
            .select()
            .single();
        if (error || !poll) {
            setIdeaActionError(error?.message ?? "Nie udało się utworzyć ankiety.");
            return;
        }

        const { data: optionRows, error: optionsError } = await supabase
            .from("poll_options")
            .insert(cleanOptions.map((label) => ({ poll_id: poll.id, label })))
            .select();
        if (optionsError || !optionRows) {
            setIdeaActionError(optionsError?.message ?? "Nie udało się dodać opcji ankiety.");
            return;
        }

        setLivePolls((prev) => [...prev, poll]);
        setLivePollOptions((prev) => [...prev, ...optionRows]);
        goToPoll(poll.id);
    };

    const castVote = async (pollId: string, optionId: string) => {
        if (!session) return;
        setIdeaActionError("");
        const { error } = await supabase
            .from("poll_votes")
            .upsert({ poll_id: pollId, option_id: optionId, user_id: session.user.id }, { onConflict: "poll_id,user_id" });
        if (error) {
            setIdeaActionError(error.message);
            return;
        }
        setLivePollVotes((prev) => {
            const withoutMine = prev.filter((row) => !(row.poll_id === pollId && row.user_id === session.user.id));
            return [
                ...withoutMine,
                { poll_id: pollId, option_id: optionId, user_id: session.user.id, created_at: new Date().toISOString() },
            ];
        });
    };

    const regenerateInvite = async () => {
        if (!session) return;
        await supabase.from("friend_invites").update({ active: false }).eq("owner_id", session.user.id).eq("active", true);
        const { data } = await supabase.from("friend_invites").insert({ owner_id: session.user.id }).select("id").single();
        if (data) setMyInvite(data);
    };

    const acceptInviteNow = async (code: string) => {
        if (!session) return null;
        const accepted = await tryAcceptInvite(code, session.user.id);
        if (accepted) {
            setLiveFriendships((prev) => [...prev, { user_id: session.user.id, friend_id: accepted.ownerId }]);
        }
        return accepted;
    };

    const handleAddGroup = async (values: { name: string; members: string[] }) => {
        if (!values.name.trim() || !session) return;

        const { data: group, error } = await supabase
            .from("idea_groups")
            .insert({ owner_id: session.user.id, name: values.name.trim() })
            .select()
            .single();

        if (error || !group) {
            setIdeaActionError(error?.message ?? "Nie udało się utworzyć grupy.");
            return;
        }

        const memberIds = Array.from(new Set([session.user.id, ...values.members]));
        const { data: memberRows, error: membersError } = await supabase
            .from("group_members")
            .insert(memberIds.map((userId) => ({ group_id: group.id, user_id: userId })))
            .select();

        if (membersError) {
            setIdeaActionError(membersError.message);
        }

        setLiveGroups((prev) => [group, ...prev]);
        if (memberRows) setLiveGroupMembers((prev) => [...prev, ...memberRows]);
    };

    const inviteToGroup = async (groupId: string, personId: string) => {
        const { data, error } = await supabase
            .from("group_members")
            .insert({ group_id: groupId, user_id: personId })
            .select()
            .single();

        if (error || !data) {
            setIdeaActionError(error?.message ?? "Nie udało się dodać osoby do grupy.");
            return;
        }

        setLiveGroupMembers((prev) => [...prev, data]);
    };

    if (authLoading) {
        return (
            <div className="app-shell auth-shell">
                <div className="card body-card">
                    <h2>Ładowanie danych...</h2>
                </div>
            </div>
        );
    }

    if (authView === "recovery") {
        return (
            <div className="app-shell auth-shell">
                <div className="card body-card auth-card">
                    <div className="eyebrow">WhishApp</div>
                    <h1>Ustaw nowe hasło</h1>
                    <div className="field-group">
                        <label>Nowe hasło</label>
                        <input
                            type="password"
                            value={recoveryPassword}
                            autoComplete="new-password"
                            onChange={(event) => setRecoveryPassword(event.target.value)}
                            placeholder="••••••••"
                        />
                    </div>
                    {authError ? <div className="error-box">{authError}</div> : null}
                    <button className="primary-button" onClick={() => void onSetNewPassword()}>Zapisz hasło</button>
                </div>
            </div>
        );
    }

    if (!session) {
        if (routeInviteCode && authView === "landing") {
            const stashAndGo = (mode: "register" | "login") => {
                if (typeof window !== "undefined") {
                    window.localStorage.setItem(PENDING_INVITE_KEY, routeInviteCode);
                }
                setAuthView(mode);
            };
            return (
                <InviteScreen
                    code={routeInviteCode}
                    isAuthenticated={false}
                    onAccept={() => {}}
                    onRegister={() => stashAndGo("register")}
                    onLogin={() => stashAndGo("login")}
                    onGoToProfile={() => {}}
                    onGoToAddFriend={() => {}}
                />
            );
        }

        if (authView === "landing") {
            return (
                <LandingScreen
                    onRegister={() => setAuthView("register")}
                    onLogin={() => setAuthView("login")}
                />
            );
        }

        if (authView === "register") {
            return (
                <div className="app-shell auth-shell">
                    <div className="card body-card auth-card">
                        <div className="eyebrow">WhishApp</div>
                        <h1>Załóż konto</h1>
                        <div className="field-group">
                            <label>Imię i nazwisko</label>
                            <input
                                value={registerForm.fullName}
                                autoComplete="name"
                                onChange={(event) => setRegisterForm((prev) => ({ ...prev, fullName: event.target.value }))}
                                placeholder="Julia Chmielewska"
                            />
                        </div>
                        <div className="field-group">
                            <label>Email</label>
                            <input
                                type="email"
                                value={registerForm.email}
                                autoComplete="email"
                                onChange={(event) => setRegisterForm((prev) => ({ ...prev, email: event.target.value }))}
                                placeholder="ty@przyklad.pl"
                            />
                        </div>
                        <div className="field-group">
                            <label>Hasło</label>
                            <input
                                type="password"
                                value={registerForm.password}
                                autoComplete="new-password"
                                onChange={(event) => setRegisterForm((prev) => ({ ...prev, password: event.target.value }))}
                                placeholder="••••••••"
                            />
                        </div>
                        {authError ? <div className="error-box">{authError}</div> : null}
                        <button className="primary-button" onClick={() => void onRegister()}>Zarejestruj się</button>
                        <button
                            className="text-button"
                            onClick={() => {
                                setAuthError("");
                                setAuthView("login");
                            }}
                        >
                            Masz już konto? Zaloguj się
                        </button>
                    </div>
                </div>
            );
        }

        if (authView === "forgot") {
            return (
                <div className="app-shell auth-shell">
                    <div className="card body-card auth-card">
                        <div className="eyebrow">WhishApp</div>
                        <h1>Reset hasła</h1>
                        <div className="field-group">
                            <label>Email</label>
                            <input
                                type="email"
                                value={forgotEmail}
                                autoComplete="email"
                                onChange={(event) => setForgotEmail(event.target.value)}
                                placeholder="ty@przyklad.pl"
                            />
                        </div>
                        {authError ? <div className="error-box">{authError}</div> : null}
                        <button className="primary-button" onClick={() => void onForgotPassword()}>Wyślij link do resetu</button>
                        <button
                            className="text-button back-button"
                            onClick={() => {
                                setAuthError("");
                                setAuthView("login");
                            }}
                        >
                            <IconArrowLeft className="back-button-icon" />
                            Wróć do logowania
                        </button>
                    </div>
                </div>
            );
        }

        return (
            <div className="app-shell auth-shell">
                <div className="card body-card auth-card">
                    <button className="text-button" onClick={() => setAuthView("landing")} style={{ alignSelf: "flex-start" }}>
                        ← WhishApp
                    </button>
                    <h1>Zaloguj się</h1>
                    <div className="field-group">
                        <label>Email</label>
                        <input
                            type="email"
                            value={loginForm.email}
                            autoComplete="email"
                            onChange={(event) => setLoginForm((prev) => ({ ...prev, email: event.target.value }))}
                            placeholder="ty@przyklad.pl"
                        />
                    </div>
                    <div className="field-group">
                        <label>Hasło</label>
                        <input
                            type="password"
                            value={loginForm.password}
                            autoComplete="current-password"
                            onChange={(event) => setLoginForm((prev) => ({ ...prev, password: event.target.value }))}
                            placeholder="••••••••"
                        />
                    </div>
                    {authInfo ? <div className="status positive">{authInfo}</div> : null}
                    {authError ? <div className="error-box">{authError}</div> : null}
                    <button className="primary-button" onClick={() => void onLogin()}>Zaloguj się</button>
                    <button
                        className="text-button"
                        onClick={() => {
                            setAuthError("");
                            setAuthView("forgot");
                        }}
                    >
                        Zapomniałeś hasła?
                    </button>
                    <button
                        className="text-button"
                        onClick={() => {
                            setAuthError("");
                            setAuthView("register");
                        }}
                    >
                        Nie masz konta? Zarejestruj się
                    </button>
                </div>
            </div>
        );
    }

    const myProfileRow = liveProfiles.find((profile) => profile.id === session.user.id);
    if (myProfileRow && !myProfileRow.has_onboarded) {
        return (
            <OnboardingScreen
                onFinish={() => void completeOnboarding()}
                onAddFirstIdea={async (title, priority) => {
                    await submitIdea({
                        title,
                        url: "",
                        price: "",
                        store: "",
                        comment: "",
                        priority,
                        visibility: [],
                        visibleToAll: false,
                        imageUrl: null,
                        imageFile: null,
                    });
                    await completeOnboarding();
                    // submitIdea nawiguje do /ideas/{id}, ale w tym miejscu historia
                    // przeglądarki sprzed onboardingu jest bezużyteczna (ekran logowania,
                    // którego już nie ma) — po dodaniu pierwszego pomysłu bezpieczniej
                    // wylądować wprost na liście, żeby "Wróć" zawsze miało dokąd wrócić.
                    router.replace("/");
                }}
            />
        );
    }

    if (routeInviteCode) {
        return (
            <InviteScreen
                code={routeInviteCode}
                isAuthenticated
                onAccept={async () => {
                    const result = await acceptInviteNow(routeInviteCode);
                    if (result) router.replace(`/people/${result.ownerId}`);
                }}
                onRegister={() => {}}
                onLogin={() => {}}
                onGoToProfile={(ownerId) => router.replace(`/people/${ownerId}`)}
                onGoToAddFriend={goToAddFriend}
            />
        );
    }

    return (
        <div className="app-shell">
            <>
                    <header className="topbar">
                        <div className="topbar-inner">
                            {screen === "ideas" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Zapiski prezentowe</div>
                                        <h1 className="ideas-heading">Co ostatnio wpadło Ci w oko?</h1>
                                    </div>
                                    <div className="topbar-actions">
                                        <button className="bell-button" onClick={goToNotifications} aria-label="Powiadomienia">
                                            <IconBell />
                                            {unreadNotificationsCount > 0 ? (
                                                <span className="bell-badge">{unreadNotificationsCount}</span>
                                            ) : null}
                                        </button>
                                        <Avatar id={effectiveMe.id} name={effectiveMe.name} avatarUrl={effectiveMe.avatar} size="small" />
                                    </div>
                                </>
                            ) : screen === "people" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Ludzie</div>
                                        <h1>Twoi bliscy</h1>
                                    </div>
                                    <div className="topbar-actions">
                                        <button className="bell-button" onClick={goToFriendRequests} aria-label="Zaproszenia do znajomych">
                                            <IconBell />
                                            {pendingIncomingRequests.length > 0 ? (
                                                <span className="bell-badge">{pendingIncomingRequests.length}</span>
                                            ) : null}
                                        </button>
                                        <button className="ghost-button" onClick={goToProfile}>
                                            Ja
                                        </button>
                                    </div>
                                </>
                            ) : screen === "friend-requests" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Ludzie</div>
                                        <h1>Zaproszenia</h1>
                                    </div>
                                    <BackButton onClick={goBack} />
                                </>
                            ) : screen === "add-friend" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Ludzie</div>
                                        <h1>Dodaj znajomego</h1>
                                    </div>
                                    <BackButton onClick={goBack} />
                                </>
                            ) : screen === "people-profile" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Profil znajomego</div>
                                        <h1>{selectedFriend.name}</h1>
                                    </div>
                                    <BackButton onClick={goToPeople} label="Wróć do ludzi" />
                                </>
                            ) : screen === "friend-list" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Lista znajomego</div>
                                        <h1>{selectedFriend.name}</h1>
                                    </div>
                                    <BackButton onClick={goBack} label="Wróć do profilu" />
                                </>
                            ) : screen === "gifts" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Prezenty</div>
                                        <h1>Organizacja i okazje</h1>
                                    </div>
                                    <div className="topbar-actions">
                                        <button className="bell-button" onClick={goToNotifications} aria-label="Powiadomienia">
                                            <IconBell />
                                            {unreadNotificationsCount > 0 ? (
                                                <span className="bell-badge">{unreadNotificationsCount}</span>
                                            ) : null}
                                        </button>
                                    </div>
                                </>
                            ) : screen === "profile" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Twój profil</div>
                                        <h1>{effectiveMe.name}</h1>
                                    </div>
                                    <div className="topbar-actions">
                                        <button className="bell-button" onClick={goToNotifications} aria-label="Powiadomienia">
                                            <IconBell />
                                            {unreadNotificationsCount > 0 ? (
                                                <span className="bell-badge">{unreadNotificationsCount}</span>
                                            ) : null}
                                        </button>
                                    </div>
                                </>
                            ) : screen === "edit-profile" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Twój profil</div>
                                        <h1>Edytuj profil</h1>
                                    </div>
                                    <BackButton onClick={goBack} />
                                </>
                            ) : screen === "privacy" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Prywatność</div>
                                        <h1>Ustawienia</h1>
                                    </div>
                                </>
                            ) : screen === "archive" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Pomysły</div>
                                        <h1>Archiwum</h1>
                                    </div>
                                    <BackButton onClick={goBack} />
                                </>
                            ) : screen === "notifications" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Pomysły</div>
                                        <h1>Powiadomienia</h1>
                                    </div>
                                    <BackButton onClick={goBack} />
                                </>
                            ) : screen === "suggest-idea" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Ludzie</div>
                                        <h1>Podrzuć pomysł</h1>
                                    </div>
                                    <BackButton onClick={goBack} />
                                </>
                            ) : screen === "gift-plans" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Pomysły</div>
                                        <h1>Wspólne prezenty</h1>
                                    </div>
                                    <BackButton onClick={goBack} />
                                </>
                            ) : screen === "gift-plan-detail" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Wspólny prezent</div>
                                        <h1>{selectedGiftPlan?.idea.title ?? "Organizacja"}</h1>
                                    </div>
                                    <BackButton onClick={goBack} />
                                </>
                            ) : screen === "occasions" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Twój profil</div>
                                        <h1>Okazje</h1>
                                    </div>
                                    <BackButton onClick={goBack} />
                                </>
                            ) : screen === "create-poll" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Ludzie</div>
                                        <h1>Ankieta dla {selectedFriend.name}</h1>
                                    </div>
                                    <BackButton onClick={goBack} />
                                </>
                            ) : screen === "polls" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Pomysły</div>
                                        <h1>Ankiety</h1>
                                    </div>
                                    <BackButton onClick={goBack} />
                                </>
                            ) : screen === "poll-detail" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Ankieta</div>
                                        <h1>{selectedPoll?.poll.question ?? "Ankieta"}</h1>
                                    </div>
                                    <BackButton onClick={goBack} />
                                </>
                            ) : screen === "add" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">{editingIdeaId ? "Edytuj pomysł" : "Dodaj pomysł"}</div>
                                        <h1>{editingIdeaId ? "Edycja pomysłu" : "Nowy pomysł"}</h1>
                                    </div>
                                </>
                            ) : screen === "detail" ? (
                                <>
                                    <div>
                                        <div className="eyebrow">Pomysł</div>
                                        <h1>{selectedIdea?.title ?? "Pomysł"}</h1>
                                    </div>
                                    <BackButton onClick={goBack} />
                                </>
                            ) : null}
                        </div>
                    </header>

                    <main className={screen === "ideas" ? "content has-fab" : "content"}>
                        {screen === "ideas" ? (
                            <IdeasScreen
                                ideas={visibleIdeas}
                                filters={filters}
                                activeFilter={activeFilter}
                                onFilterChange={setActiveFilter}
                                onSelectIdea={goToIdeaDetail}
                                groupNameById={groupNameById}
                            />
                        ) : null}

                        {screen === "friend-list" ? (
                            <IdeasScreen
                                ideas={friendVisibleIdeas}
                                filters={filters}
                                activeFilter={friendListFilter}
                                onFilterChange={(filter) => setFriendListFilter(filter)}
                                onSelectIdea={(ideaId) => goToFriendIdeaDetail(selectedFriend.id, ideaId)}
                                title={`${selectedFriend.name}`}
                                reservationStatus={reservationStatus}
                                groupNameById={groupNameById}
                            />
                        ) : null}

                        {screen === "add" ? (
                            <AddIdeaScreen
                                key={editingIdeaId ?? "new"}
                                initialValues={addIdeaInitialValues}
                                groups={myGroups}
                                onSubmit={(values) => void submitIdea(values)}
                                isEditing={editingIdeaId !== null}
                                error={ideaActionError}
                            />
                        ) : null}

                        {screen === "detail" ? (
                            <DetailScreen
                                idea={selectedIdea}
                                groups={myGroups}
                                myReservation={selectedIdea ? myReservationByIdeaId.get(selectedIdea.id) : undefined}
                                reservedByOther={!!selectedIdea && !!reservationStatus[selectedIdea.id]?.reserved && !myReservationByIdeaId.has(selectedIdea.id)}
                                reservationsAllowed={selectedIdeaOwnerAllowsReservations}
                                onReserve={() => void onReserve()}
                                onMarkPurchased={(reservationId) => void onMarkPurchased(reservationId)}
                                onCancelReservation={(reservationId, wasPurchased) => void onCancelReservation(reservationId, wasPurchased)}
                                onMarkReceived={detailOwner === "mine" ? () => selectedIdea && void onMarkReceived(selectedIdea.id) : undefined}
                                myGiftPlanId={selectedIdea ? myGiftPlans.find((row) => row.idea.id === selectedIdea.id)?.plan.id ?? null : null}
                                onOrganizeTogether={
                                    detailOwner === "friend" && selectedIdea
                                        ? () => {
                                              const existing = myGiftPlans.find((row) => row.idea.id === selectedIdea.id);
                                              if (existing) {
                                                  goToGiftPlan(existing.plan.id);
                                              } else {
                                                  void createGiftPlan(selectedIdea.id);
                                              }
                                          }
                                        : undefined
                                }
                                onBack={goBack}
                                showVisibility={detailOwner === "mine"}
                                onEdit={detailOwner === "mine" ? () => selectedIdea && goToEditIdea(selectedIdea.id) : undefined}
                                onDelete={
                                    detailOwner === "mine"
                                        ? () => {
                                              void (async () => {
                                                  if (
                                                      selectedIdea &&
                                                      (await askConfirm({ title: "Usunąć ten pomysł?", confirmLabel: "Usuń", danger: true }))
                                                  ) {
                                                      void deleteIdea(selectedIdea.id);
                                                  }
                                              })();
                                          }
                                        : undefined
                                }
                                error={ideaActionError}
                            />
                        ) : null}

                        {screen === "archive" ? (
                            <IdeasScreen
                                ideas={myArchivedIdeas}
                                filters={[]}
                                activeFilter="wszystkie"
                                onFilterChange={() => {}}
                                onSelectIdea={goToIdeaDetail}
                                title="Otrzymane pomysły"
                                groupNameById={groupNameById}
                            />
                        ) : null}

                        {screen === "notifications" ? (
                            <NotificationsScreen
                                notifications={liveNotifications}
                                ideasById={Object.fromEntries(liveIdeas.map((row) => [row.id, row.title]))}
                                namesById={Object.fromEntries(liveProfiles.map((row) => [row.id, row.full_name]))}
                                tab={notificationsTab}
                                onTabChange={setNotificationsTab}
                                incoming={pendingIncomingRequests}
                                outgoing={pendingOutgoingRequests}
                                onAccept={(requestId, senderId) => void acceptFriendRequest(requestId, senderId)}
                                onDecline={(requestId) => void cancelFriendRequest(requestId)}
                                onCancel={(requestId) => void cancelFriendRequest(requestId)}
                                incomingSuggestions={incomingSuggestions}
                                outgoingSuggestions={outgoingSuggestions}
                                onAcceptSuggestion={(suggestion) => void respondToSuggestion(suggestion, true)}
                                onDismissSuggestion={(suggestion) => void respondToSuggestion(suggestion, false)}
                                onOpenIdea={goToIdeaDetail}
                                onOpenPerson={goToPersonProfile}
                                onOpenGiftPlan={goToGiftPlan}
                                onOpenPoll={goToPoll}
                            />
                        ) : null}

                        {screen === "suggest-idea" ? (
                            <SuggestIdeaScreen
                                friendName={selectedFriend.name}
                                onSubmit={(title, url, imageFile) => void sendIdeaSuggestion(selectedFriend.id, title, url, imageFile)}
                                error={ideaActionError}
                            />
                        ) : null}

                        {screen === "gift-plans" ? (
                            <GiftPlansScreen
                                plans={myGiftPlans}
                                onSelectPlan={goToGiftPlan}
                                onRespond={(planId, accept) => void respondToGiftPlanInvite(planId, accept)}
                                namesById={Object.fromEntries(liveProfiles.map((row) => [row.id, row.full_name]))}
                            />
                        ) : null}

                        {screen === "gift-plan-detail" ? (
                            <GiftPlanDetailScreen
                                plan={selectedGiftPlan}
                                participants={selectedGiftPlanParticipants}
                                myId={session.user.id}
                                invitableFriends={effectivePeople.filter(
                                    (person) =>
                                        person.id !== selectedGiftPlan?.idea.ownerId &&
                                        !selectedGiftPlanParticipants.some((p) => p.userId === person.id)
                                )}
                                onInvite={(userId) => selectedGiftPlan && void inviteToGiftPlan(selectedGiftPlan.plan.id, userId)}
                                onRespond={(accept) => selectedGiftPlan && void respondToGiftPlanInvite(selectedGiftPlan.plan.id, accept)}
                                chatMessages={chatMessages}
                                chatDraft={chatDraft}
                                onChatDraftChange={setChatDraft}
                                onSendChatMessage={() => selectedGiftPlan && void sendChatMessage(selectedGiftPlan.plan.id, chatDraft)}
                                namesById={Object.fromEntries(liveProfiles.map((row) => [row.id, row.full_name]))}
                                error={ideaActionError}
                            />
                        ) : null}

                        {screen === "occasions" ? (
                            <OccasionsScreen
                                occasions={myOccasions}
                                groups={myGroups}
                                onAdd={(name, date, groupId) => void addOccasion(name, date, groupId)}
                                onDelete={(id) => void deleteOccasion(id)}
                                error={ideaActionError}
                            />
                        ) : null}

                        {screen === "create-poll" ? (
                            <CreatePollScreen
                                friendName={selectedFriend.name}
                                groups={myGroups}
                                onSubmit={(question, options, groupId) =>
                                    void createPoll(selectedFriend.id, question, options, groupId)
                                }
                                error={ideaActionError}
                            />
                        ) : null}

                        {screen === "polls" ? (
                            <PollsScreen polls={myVisiblePolls} onSelectPoll={goToPoll} />
                        ) : null}

                        {screen === "poll-detail" ? (
                            <PollDetailScreen
                                poll={selectedPoll}
                                onVote={(optionId) => selectedPoll && void castVote(selectedPoll.poll.id, optionId)}
                            />
                        ) : null}

                        {screen === "people" ? (
                            <PeopleScreen
                                people={effectivePeople}
                                groups={myGroups}
                                tab={peopleTab}
                                onTabChange={setPeopleTab}
                                onSelectFriend={goToPersonProfile}
                                onAddFriend={goToAddFriend}
                                onAddGroup={(values) => void handleAddGroup(values)}
                                onInvite={(groupId, personId) => void inviteToGroup(groupId, personId)}
                                onToggleGroupReservations={(groupId, next) => void toggleGroupReservations(groupId, next)}
                            />
                        ) : null}

                        {screen === "add-friend" ? (
                            <AddFriendScreen
                                candidates={friendSearchCandidates}
                                onSendRequest={(id) => void sendFriendRequest(id)}
                                onAcceptRequest={(requestId, senderId) => void acceptFriendRequest(requestId, senderId)}
                                inviteCode={myInvite?.id ?? null}
                                onRegenerateInvite={() => void regenerateInvite()}
                            />
                        ) : null}

                        {screen === "friend-requests" ? (
                            <FriendRequestsScreen
                                incoming={pendingIncomingRequests}
                                outgoing={pendingOutgoingRequests}
                                onAccept={(requestId, senderId) => void acceptFriendRequest(requestId, senderId)}
                                onDecline={(requestId) => void cancelFriendRequest(requestId)}
                                onCancel={(requestId) => void cancelFriendRequest(requestId)}
                            />
                        ) : null}

                        {screen === "people-profile" ? (
                            <ProfileScreen
                                friend={selectedFriend}
                                currentUser={effectiveMe}
                                friendIdeas={effectiveFriendIdeas[selectedFriend.id] ?? []}
                                onOpenPrivacy={goToPrivacy}
                                onBackToPeople={goToPeople}
                                onSelectIdea={(ideaId) => goToFriendIdeaDetail(selectedFriend.id, ideaId)}
                                onOpenPriority={(priority) => {
                                    setFriendListFilter(priority);
                                    goToPersonIdeas(selectedFriend.id);
                                }}
                                onSuggestIdea={() => goToSuggestIdea(selectedFriend.id)}
                                onCreatePoll={() => goToCreatePoll(selectedFriend.id)}
                            />
                        ) : null}

                        {screen === "gifts" ? (
                            <GiftsScreen
                                people={effectivePeople}
                                onSelectFriend={goToPersonProfile}
                                friendIdeasByPersonId={effectiveFriendIdeas}
                                onSelectIdea={goToFriendIdeaDetail}
                                occasions={upcomingFriendOccasions}
                            />
                        ) : null}

                        {screen === "profile" ? (
                            <ProfileScreen
                                friend={effectiveMe}
                                currentUser={effectiveMe}
                                friendIdeas={ideas}
                                myReservedIdeas={myReservedIdeas}
                                onOpenPrivacy={goToPrivacy}
                                onEditProfile={goToEditProfile}
                                onBackToPeople={goToPeople}
                                onLogout={() => {
                                    void (async () => {
                                        if (await askConfirm({ title: "Wylogować się?", confirmLabel: "Wyloguj się" })) {
                                            void onLogout();
                                        }
                                    })();
                                }}
                                onSelectIdea={goToIdeaDetail}
                                onSelectReservedIdea={goToFriendIdeaDetail}
                                onOpenPriority={(priority) => {
                                    setActiveFilter(priority);
                                    goToIdeas();
                                }}
                                onViewMyIdeas={() => {
                                    setActiveFilter("wszystkie");
                                    goToIdeas();
                                }}
                                archivedCount={myArchivedIdeas.length}
                                onOpenArchive={goToArchive}
                                giftPlansCount={myGiftPlans.length}
                                onOpenGiftPlans={goToGiftPlans}
                                occasionsCount={myOccasions.length}
                                onOpenOccasions={goToOccasions}
                                pollsCount={myVisiblePolls.length}
                                onOpenPolls={goToPolls}
                            />
                        ) : null}

                        {screen === "edit-profile" ? (
                            <EditProfileScreen
                                me={effectiveMe}
                                email={session.user.email ?? ""}
                                onSaveProfile={(values) => void updateProfileFields(values)}
                                onUploadAvatar={(file) => void uploadAvatar(file)}
                                onRemoveAvatar={() => void removeAvatar()}
                                onChangeEmail={(value) => void updateEmail(value)}
                                onChangePassword={(value) => void updatePassword(value)}
                                error={ideaActionError}
                                info={profileInfo}
                            />
                        ) : null}

                        {screen === "privacy" ? (
                            <PrivacyScreen
                                onManageGroups={goToPeople}
                                reservationsEnabled={liveProfiles.find((p) => p.id === session.user.id)?.reservations_enabled ?? true}
                                onToggleReservations={(next) => void toggleGlobalReservations(next)}
                                onDeleteAccount={() => {
                                    void (async () => {
                                        if (
                                            await askConfirm({
                                                title: "Usunąć konto na stałe?",
                                                message: "Tej operacji nie da się cofnąć.",
                                                confirmLabel: "Usuń konto",
                                                danger: true,
                                            })
                                        ) {
                                            void deleteAccount();
                                        }
                                    })();
                                }}
                                error={ideaActionError}
                            />
                        ) : null}
                    </main>

                    <nav className="bottom-nav">
                        <span className="nav-indicator" data-index={activeNavIndex ?? "none"} />
                        <button className={screen === "ideas" ? "nav-item active" : "nav-item"} onClick={goToIdeas}>
                            <span>✦</span>
                            <small>Pomysły</small>
                        </button>
                        <button className={screen === "people" || screen === "people-profile" || screen === "friend-requests" ? "nav-item active" : "nav-item"} onClick={goToPeople}>
                            <span className="nav-icon-wrap">
                                ◍
                                {pendingIncomingRequests.length > 0 ? <span className="nav-dot" /> : null}
                            </span>
                            <small>Ludzie</small>
                        </button>
                        <button className={screen === "gifts" ? "nav-item active" : "nav-item"} onClick={goToGifts}>
                            <span className="nav-icon-wrap">
                                ❀
                                {pendingGiftPlanInvitesCount > 0 ? <span className="nav-dot" /> : null}
                            </span>
                            <small>Prezenty</small>
                        </button>
                        <button className={screen === "profile" ? "nav-item active" : "nav-item"} onClick={goToProfile}>
                            <span>☾</span>
                            <small>Ja</small>
                        </button>
                    </nav>

                    {screen === "ideas" ? (
                        <button className="fab" onClick={goToAddIdea}>+ Dodaj pomysł</button>
                    ) : null}

                    {confirmRequest ? (
                        <div className="confirm-overlay">
                            <div className="confirm-dialog">
                                <h3>{confirmRequest.title}</h3>
                                {confirmRequest.message ? <p>{confirmRequest.message}</p> : null}
                                <div className="confirm-actions">
                                    <button className="secondary-button" onClick={() => resolveConfirm(false)}>
                                        {confirmRequest.cancelLabel}
                                    </button>
                                    <button
                                        className={confirmRequest.danger ? "primary-button danger-button" : "primary-button"}
                                        onClick={() => resolveConfirm(true)}
                                    >
                                        {confirmRequest.confirmLabel}
                                    </button>
                                </div>
                            </div>
                        </div>
                    ) : null}
                </>
        </div>
    );
}

function IdeasScreen({
    ideas,
    filters,
    activeFilter,
    onFilterChange,
    onSelectIdea,
    title = "Ostatnio dodane",
    reservationStatus,
    groupNameById,
}: {
    ideas: Idea[];
    filters: Array<{ id: string; label: string }>;
    activeFilter: string;
    onFilterChange: (id: string) => void;
    onSelectIdea: (id: string) => void;
    title?: string;
    reservationStatus?: Record<string, { reserved: boolean; byMe: boolean }>;
    groupNameById: Record<string, string>;
}) {
    const recent = ideas.slice(0, 2);
    const rest = ideas.slice(2);
    const isReserved = (ideaId: string) => Boolean(reservationStatus?.[ideaId]?.reserved);

    return (
        <>
            <div className="filter-row">
                {filters.map((filter) => (
                    <button
                        key={filter.id}
                        className={activeFilter === filter.id ? "filter-button active" : "filter-button"}
                        onClick={() => onFilterChange(filter.id)}
                    >
                        {filter.label}
                    </button>
                ))}
            </div>

            <section className="section">
                <div className="section-header">
                    <h2>{title}</h2>
                    <span>{recent.length} {ideaWord(recent.length)}</span>
                </div>

                <div className="stack">
                    {recent.map((idea) => (
                        <IdeaCard key={idea.id} idea={idea} reserved={isReserved(idea.id)} onClick={() => onSelectIdea(idea.id)} groupNameById={groupNameById} />
                    ))}
                </div>
            </section>

            <section className="section">
                <div className="section-header">
                    <h2>Wszystkie pomysły</h2>
                    <span>{rest.length} {ideaWord(rest.length)}</span>
                </div>
                <div className="idea-grid">
                    {rest.map((idea) => (
                        <IdeaCard key={idea.id} idea={idea} compact reserved={isReserved(idea.id)} onClick={() => onSelectIdea(idea.id)} groupNameById={groupNameById} />
                    ))}
                </div>
            </section>
        </>
    );
}

function IdeaCard({
    idea,
    compact = false,
    reserved = false,
    onClick,
    groupNameById,
}: {
    idea: Idea;
    compact?: boolean;
    reserved?: boolean;
    onClick: () => void;
    groupNameById: Record<string, string>;
}) {
    const visibilityLabel = idea.visibleToAll
        ? "🌍 Wszyscy"
        : idea.visibility.length === 0
          ? "🔒 Tylko ja"
          : idea.visibility.map((groupId) => groupNameById[groupId] ?? "?").join(", ");

    const cardClass = [
        "idea-card",
        compact ? "compact" : "",
        idea.image ? "" : "no-image",
    ].filter(Boolean).join(" ");

    return (
        <button className={cardClass} onClick={onClick}>
            {idea.image ? (
                <div className="idea-image-wrap">
                    <img src={idea.image} alt={idea.title} />
                    {reserved ? <span className="reserved-badge">🔒 Zarezerwowane</span> : null}
                </div>
            ) : null}
            <div className="card-body">
                <div className="row-between">
                    <span className="priority">{priorityMeta[idea.priority].emoji} {priorityMeta[idea.priority].short}</span>
                    {!idea.image && reserved ? <span className="status">🔒 Zarezerwowane</span> : null}
                    <span className="muted">{visibilityLabel}</span>
                </div>
                <h3>{idea.title}</h3>
                <p>{idea.note}</p>
                <div className="row-between price-row">
                    <strong>{idea.price ? `${idea.price} zł` : "bez ceny"}</strong>
                    <span className="muted small">{idea.store}</span>
                </div>
            </div>
        </button>
    );
}

type NewIdeaForm = {
    title: string;
    url: string;
    price: string;
    store: string;
    comment: string;
    priority: Priority;
    visibility: string[];
    visibleToAll: boolean;
    imageUrl: string | null;
    imageFile: File | null;
};

function AddIdeaScreen({
    initialValues,
    groups,
    onSubmit,
    isEditing = false,
    error,
}: {
    initialValues: NewIdeaForm;
    groups: Array<{ id: string; name: string }>;
    onSubmit: (values: NewIdeaForm) => void;
    isEditing?: boolean;
    error?: string;
}) {
    const [newIdea, setNewIdea] = useState<NewIdeaForm>(initialValues);
    const filePreviewUrl = useMemo(
        () => (newIdea.imageFile ? URL.createObjectURL(newIdea.imageFile) : null),
        [newIdea.imageFile]
    );
    useEffect(() => {
        return () => {
            if (filePreviewUrl) URL.revokeObjectURL(filePreviewUrl);
        };
    }, [filePreviewUrl]);
    const previewUrl = filePreviewUrl ?? newIdea.imageUrl;
    const [isFetchingMetadata, setIsFetchingMetadata] = useState(false);
    const lastFetchedUrl = useRef<string | null>(null);

    // ETAP 5: przy opuszczeniu pola URL próbujemy sami wyciągnąć nazwę/
    // zdjęcie/cenę/sklep z tagów Open Graph strony. Uzupełniamy tylko pola,
    // których użytkownik jeszcze nie ruszył — nigdy nie nadpisujemy tego, co
    // już wpisał ręcznie. Błąd/timeout = po prostu zostaje formularz ręczny,
    // dokładnie tak jak wymaga instrukcja.
    const handleUrlBlur = async () => {
        const url = newIdea.url.trim();
        if (!url || url === lastFetchedUrl.current) return;
        lastFetchedUrl.current = url;
        setIsFetchingMetadata(true);
        try {
            const response = await fetch("/api/fetch-link-metadata", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url }),
            });
            const data = await response.json();
            if (!data.error) {
                setNewIdea((prev) => ({
                    ...prev,
                    title: prev.title.trim() ? prev.title : data.title ?? prev.title,
                    store: prev.store.trim() ? prev.store : data.store ?? prev.store,
                    price: prev.price.trim() ? prev.price : data.price != null ? String(data.price) : prev.price,
                    comment: prev.comment.trim() ? prev.comment : data.description ?? prev.comment,
                    imageUrl: prev.imageFile || prev.imageUrl ? prev.imageUrl : (data.image ?? prev.imageUrl),
                }));
            }
        } catch {
            // cicho — patrz komentarz wyżej
        } finally {
            setIsFetchingMetadata(false);
        }
    };

    return (
        <div className="stack-form">
            <div className="field-group">
                <label>Zdjęcie (opcjonalnie)</label>
                {previewUrl ? (
                    <div className="idea-photo-preview">
                        <img src={previewUrl} alt="Podgląd pomysłu" />
                        <button
                            type="button"
                            className="ghost-button"
                            onClick={() => setNewIdea({ ...newIdea, imageFile: null, imageUrl: null })}
                        >
                            Usuń zdjęcie
                        </button>
                    </div>
                ) : (
                    <label className="photo-upload-button">
                        + Dodaj zdjęcie
                        <input
                            type="file"
                            accept="image/*"
                            className="visually-hidden"
                            onChange={(event) => {
                                const file = event.target.files?.[0] ?? null;
                                setNewIdea({ ...newIdea, imageFile: file });
                            }}
                        />
                    </label>
                )}
            </div>
            <div className="field-group">
                <label>URL / link</label>
                <input
                    value={newIdea.url}
                    onChange={(event) => {
                        const url = event.target.value;
                        const guessedStore = newIdea.store.trim() === "" ? guessStoreFromUrl(url) : newIdea.store;
                        setNewIdea({ ...newIdea, url, store: guessedStore });
                    }}
                    onBlur={() => void handleUrlBlur()}
                    placeholder="https://..."
                />
                {isFetchingMetadata ? <p className="muted small">Pobieram informacje o produkcie...</p> : null}
            </div>
            <div className="field-group">
                <label>Nazwa</label>
                <input
                    value={newIdea.title}
                    onChange={(event) => setNewIdea({ ...newIdea, title: event.target.value })}
                    placeholder="np. Słuchawki Sony"
                />
            </div>
            <div className="two-col">
                <div className="field-group">
                    <label>Cena</label>
                    <input
                        value={newIdea.price}
                        onChange={(event) => setNewIdea({ ...newIdea, price: event.target.value })}
                        placeholder="299"
                    />
                </div>
                <div className="field-group">
                    <label>Sklep</label>
                    <input
                        value={newIdea.store}
                        onChange={(event) => setNewIdea({ ...newIdea, store: event.target.value })}
                        placeholder="Media Expert"
                    />
                </div>
            </div>
            <div className="field-group">
                <label>Komentarz</label>
                <textarea
                    value={newIdea.comment}
                    onChange={(event) => setNewIdea({ ...newIdea, comment: event.target.value })}
                    placeholder="Dlaczego to jest dla mnie ważne?"
                />
            </div>

            <div className="field-group">
                <label>Priorytet</label>
                <div className="chip-row">
                    {(["bardzo", "chce", "moze"] as Priority[]).map((priority) => (
                        <button
                            key={priority}
                            className={newIdea.priority === priority ? "chip active" : "chip"}
                            onClick={() => setNewIdea({ ...newIdea, priority })}
                        >
                            {priorityMeta[priority].emoji} {priorityMeta[priority].label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="field-group">
                <label>Widoczność</label>
                <div className="chip-row wrap">
                    <button
                        className={!newIdea.visibleToAll && newIdea.visibility.length === 0 ? "chip active" : "chip"}
                        onClick={() => setNewIdea({ ...newIdea, visibility: [], visibleToAll: false })}
                    >
                        🔒 Tylko ja
                    </button>
                    <button
                        className={newIdea.visibleToAll ? "chip active" : "chip"}
                        onClick={() => setNewIdea({ ...newIdea, visibility: [], visibleToAll: true })}
                    >
                        🌍 Wszyscy znajomi
                    </button>
                    {groups.map((group) => {
                        const active = !newIdea.visibleToAll && newIdea.visibility.includes(group.id);
                        return (
                            <button
                                key={group.id}
                                className={active ? "chip active" : "chip"}
                                onClick={() => {
                                    const next = active
                                        ? newIdea.visibility.filter((item) => item !== group.id)
                                        : [...newIdea.visibility, group.id];
                                    setNewIdea({ ...newIdea, visibility: next, visibleToAll: false });
                                }}
                            >
                                {group.name}
                            </button>
                        );
                    })}
                </div>
                {groups.length === 0 ? (
                    <p className="muted small">Nie masz jeszcze żadnych grup — pomysł będzie widoczny tylko dla Ciebie. Grupy założysz w zakładce Ludzie.</p>
                ) : null}
            </div>

            {error ? <div className="error-box">{error}</div> : null}
            <button className="primary-button" onClick={() => onSubmit(newIdea)}>{isEditing ? "Zapisz zmiany" : "Dodaj pomysł"}</button>
        </div>
    );
}

function DetailScreen({
    idea,
    groups,
    myReservation,
    reservedByOther,
    reservationsAllowed = true,
    onReserve,
    onMarkPurchased,
    onCancelReservation,
    onMarkReceived,
    onBack,
    showVisibility = true,
    onEdit,
    onDelete,
    myGiftPlanId,
    onOrganizeTogether,
    error,
}: {
    idea: Idea | null;
    groups: Array<{ id: string; name: string }>;
    myReservation?: { id: string; status: "reserved" | "purchased" | "cancelled" | "completed" };
    reservedByOther: boolean;
    reservationsAllowed?: boolean;
    onReserve: () => void;
    onMarkPurchased: (reservationId: string) => void;
    onCancelReservation: (reservationId: string, wasPurchased: boolean) => void;
    onMarkReceived?: () => void;
    onBack: () => void;
    showVisibility?: boolean;
    onEdit?: () => void;
    onDelete?: () => void;
    myGiftPlanId?: string | null;
    onOrganizeTogether?: () => void;
    error?: string;
}) {
    if (!idea) return null;

    const isArchived = idea.status === "archived";

    return (
        <div className="stack">
            {idea.image ? (
                <div className="card image-card detail-card">
                    <img src={idea.image} alt={idea.title} />
                </div>
            ) : null}

            <div className="card body-card">
                <div className="row-between">
                    <span className="priority">{priorityMeta[idea.priority].emoji} {priorityMeta[idea.priority].label}</span>
                    {isArchived ? <span className="status positive">❤️ Otrzymany</span> : null}
                    {!isArchived && !showVisibility && myReservation?.status === "reserved" ? (
                        <span className="status positive">🎁 Zarezerwowane</span>
                    ) : null}
                    {!isArchived && !showVisibility && myReservation?.status === "purchased" ? (
                        <span className="status positive">✓ Kupione</span>
                    ) : null}
                    {!isArchived && !showVisibility && !myReservation && reservedByOther ? (
                        <span className="status">Ktoś już to rezerwuje</span>
                    ) : null}
                </div>
                <h2>{idea.title}</h2>
                <div className="price-row row-between">
                    <strong>{idea.price ? `${idea.price} zł` : "Bez ceny"}</strong>
                    <span>{idea.store}</span>
                </div>
                <p>{idea.note}</p>
                {idea.url ? (
                    <a href={idea.url} target="_blank" rel="noreferrer" className="store-link-button">
                        {idea.store && idea.store !== "Sklep" ? idea.store : "Zobacz w sklepie"}
                        <IconExternalLink className="store-link-icon" />
                    </a>
                ) : null}
                <div className="muted">
                    {isArchived && idea.archivedAt ? `Otrzymano ${idea.archivedAt}` : `Dodane ${idea.addedAt}`}
                </div>
            </div>

            {showVisibility ? (
                <div className="card body-card">
                    <h3>Widoczność</h3>
                    {idea.visibleToAll ? (
                        <p className="muted">🌍 Widoczne dla wszystkich znajomych.</p>
                    ) : idea.visibility.length === 0 ? (
                        <p className="muted">🔒 Tylko ja — nie udostępniono żadnej grupie.</p>
                    ) : (
                        <div className="stack small-stack">
                            {groups.map((group) => {
                                const visible = idea.visibility.includes(group.id);
                                return (
                                    <div className="list-row" key={group.id}>
                                        <span>👥 {group.name}</span>
                                        <span className={visible ? "status positive" : "status"}>
                                            {visible ? "widoczne" : "ukryte"}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            ) : null}

            {error ? <div className="error-box">{error}</div> : null}

            {!isArchived && !showVisibility && reservationsAllowed ? (
                <>
                    <div className="card body-card info-callout">
                        <strong>Właściciel pomysłu nie zobaczy, że został zarezerwowany.</strong>
                    </div>

                    {!myReservation ? (
                        <button className="primary-button" onClick={onReserve} disabled={reservedByOther}>
                            {reservedByOther ? "🔒 Ktoś już to rezerwuje" : "🎁 Zarezerwuj"}
                        </button>
                    ) : myReservation.status === "reserved" ? (
                        <>
                            <button className="primary-button" onClick={() => onMarkPurchased(myReservation.id)}>
                                ✓ Kupione
                            </button>
                            <button
                                className="secondary-button danger-button"
                                onClick={() => onCancelReservation(myReservation.id, false)}
                            >
                                Anuluj rezerwację
                            </button>
                        </>
                    ) : myReservation.status === "purchased" ? (
                        <button
                            className="secondary-button danger-button"
                            onClick={() => onCancelReservation(myReservation.id, true)}
                        >
                            Anuluj rezerwację
                        </button>
                    ) : null}
                </>
            ) : null}

            {!isArchived && !showVisibility && !reservationsAllowed && !myReservation ? (
                <div className="card body-card info-callout">
                    <strong>Właściciel wyłączył rezerwacje dla swoich pomysłów.</strong>
                </div>
            ) : null}

            {!isArchived && !showVisibility && onOrganizeTogether ? (
                <button className="secondary-button" onClick={onOrganizeTogether}>
                    {myGiftPlanId ? "🤝 Zobacz wspólną organizację" : "🤝 Zorganizujcie razem"}
                </button>
            ) : null}

            {!isArchived && showVisibility && onMarkReceived ? (
                <button className="primary-button" onClick={onMarkReceived}>❤️ Dostałem</button>
            ) : null}

            {showVisibility && onEdit ? (
                <button className="secondary-button" onClick={onEdit}>Edytuj pomysł</button>
            ) : null}
            {showVisibility && onDelete ? (
                <button className="secondary-button danger-button" onClick={onDelete}>Usuń pomysł</button>
            ) : null}
            <button className="secondary-button back-button" onClick={onBack}>
                <IconArrowLeft className="back-button-icon" />
                Wróć
            </button>
        </div>
    );
}

function NotificationsScreen({
    notifications,
    ideasById,
    namesById,
    tab,
    onTabChange,
    incoming,
    outgoing,
    onAccept,
    onDecline,
    onCancel,
    incomingSuggestions,
    outgoingSuggestions,
    onAcceptSuggestion,
    onDismissSuggestion,
    onOpenIdea,
    onOpenPerson,
    onOpenGiftPlan,
    onOpenPoll,
}: {
    notifications: Array<NotificationRow>;
    ideasById: Record<string, string>;
    namesById: Record<string, string>;
    tab: "wszystkie" | "zaproszenia" | "sugestie";
    onTabChange: (tab: "wszystkie" | "zaproszenia" | "sugestie") => void;
    incoming: Array<{ requestId: string; id: string; name: string; avatar: string | null }>;
    outgoing: Array<{ requestId: string; id: string; name: string; avatar: string | null }>;
    onAccept: (requestId: string, senderId: string) => void;
    onDecline: (requestId: string) => void;
    onCancel: (requestId: string) => void;
    incomingSuggestions: Array<IdeaSuggestionRow & { senderName: string }>;
    outgoingSuggestions: Array<IdeaSuggestionRow & { recipientName: string }>;
    onAcceptSuggestion: (suggestion: IdeaSuggestionRow) => void;
    onDismissSuggestion: (suggestion: IdeaSuggestionRow) => void;
    onOpenIdea: (ideaId: string) => void;
    onOpenPerson: (personId: string) => void;
    onOpenGiftPlan: (planId: string) => void;
    onOpenPoll: (pollId: string) => void;
}) {
    const textFor = (notification: NotificationRow) => {
        const ideaTitle = notification.idea_id ? ideasById[notification.idea_id] : undefined;
        const personName = notification.related_user_id ? namesById[notification.related_user_id] : undefined;
        switch (notification.type) {
            case "gift_received_purchased_confirmed":
                return `❤️ Dostał${ideaTitle ? ` Twój prezent „${ideaTitle}"` : " Twój prezent"}!`;
            case "gift_received_reserved":
                return `❤️ Ktoś już dostał${ideaTitle ? ` prezent „${ideaTitle}"` : " ten prezent"}! Mamy nadzieję, że jeszcze go nie kupiłeś.`;
            case "friend_request_received":
                return `👋 ${personName ?? "Ktoś"} wysłał(a) Ci zaproszenie do znajomych.`;
            case "friend_request_accepted":
                return `🎉 ${personName ?? "Ktoś"} zaakceptował(a) Twoje zaproszenie do znajomych.`;
            case "idea_suggestion_received":
                return `💡 ${personName ?? "Ktoś"} podrzucił(a) Ci pomysł na prezent.`;
            case "gift_plan_invite":
                return `🤝 ${personName ?? "Ktoś"} zaprosił(a) Cię do wspólnej organizacji prezentu${ideaTitle ? ` „${ideaTitle}"` : ""}.`;
            case "poll_created":
                return `📊 ${personName ?? "Ktoś"} stworzył(a) nową ankietę o pomysłach na prezent.`;
            default:
                return "Nowe powiadomienie.";
        }
    };

    // Każdy typ powiadomienia prowadzi tam, gdzie faktycznie żyje jego treść —
    // dla zaproszeń/sugestii to przełączenie zakładki w tym samym ekranie,
    // dla reszty nawigacja do konkretnego pomysłu/planu/ankiety/osoby.
    const onOpenFor = (notification: NotificationRow): (() => void) | null => {
        switch (notification.type) {
            case "gift_received_purchased_confirmed":
            case "gift_received_reserved":
                return notification.idea_id ? () => onOpenIdea(notification.idea_id!) : null;
            case "friend_request_received":
                return () => onTabChange("zaproszenia");
            case "friend_request_accepted":
                return notification.related_user_id ? () => onOpenPerson(notification.related_user_id!) : null;
            case "idea_suggestion_received":
                return () => onTabChange("sugestie");
            case "gift_plan_invite":
                return notification.gift_plan_id ? () => onOpenGiftPlan(notification.gift_plan_id!) : null;
            case "poll_created":
                return notification.poll_id ? () => onOpenPoll(notification.poll_id!) : null;
            default:
                return null;
        }
    };

    return (
        <div className="stack">
            <div className="tab-row three-col">
                <button className={tab === "wszystkie" ? "tab-button active" : "tab-button"} onClick={() => onTabChange("wszystkie")}>
                    Wszystkie
                </button>
                <button className={tab === "zaproszenia" ? "tab-button active" : "tab-button"} onClick={() => onTabChange("zaproszenia")}>
                    Zaproszenia
                </button>
                <button className={tab === "sugestie" ? "tab-button active" : "tab-button"} onClick={() => onTabChange("sugestie")}>
                    Sugestie
                </button>
            </div>

            {tab === "sugestie" ? (
                <>
                    <div className="card body-card">
                        <h3>Podrzucone Tobie</h3>
                        {incomingSuggestions.length === 0 ? (
                            <p className="muted small">Nikt jeszcze nie podrzucił Ci pomysłu.</p>
                        ) : (
                            <div className="stack small-stack">
                                {incomingSuggestions.map((suggestion) => (
                                    <div className="person-row" key={suggestion.id}>
                                        {suggestion.image_url ? (
                                            <img className="avatar medium" src={suggestion.image_url} alt={suggestion.title} />
                                        ) : (
                                            <Avatar id={suggestion.id} name={suggestion.title} avatarUrl={null} size="medium" />
                                        )}
                                        <div className="person-meta">
                                            <strong>{suggestion.title}</strong>
                                            <span>od {suggestion.senderName}</span>
                                        </div>
                                        <div className="chip-row">
                                            <button className="mini-button" onClick={() => onAcceptSuggestion(suggestion)}>Dodaj</button>
                                            <button className="ghost-button" onClick={() => onDismissSuggestion(suggestion)}>Odrzuć</button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="card body-card">
                        <h3>Wysłane sugestie</h3>
                        {outgoingSuggestions.length === 0 ? (
                            <p className="muted small">Nie podrzuciłeś jeszcze nikomu pomysłu.</p>
                        ) : (
                            <div className="stack small-stack">
                                {outgoingSuggestions.map((suggestion) => (
                                    <div className="list-row" key={suggestion.id}>
                                        <span>{suggestion.title} — dla {suggestion.recipientName}</span>
                                        <span className={suggestion.status === "pending" ? "status" : "status positive"}>
                                            {suggestion.status === "pending" ? "Oczekuje" : suggestion.status === "accepted" ? "Dodane" : "Odrzucone"}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </>
            ) : tab === "wszystkie" ? (
                notifications.length === 0 ? (
                    <div className="card body-card">
                        <p className="muted">Nie masz jeszcze żadnych powiadomień.</p>
                    </div>
                ) : (
                    notifications.map((notification) => {
                        const onOpen = onOpenFor(notification);
                        const className = notification.read ? "card body-card" : "card body-card info-callout";
                        return onOpen ? (
                            <button className={`${className} summary-link`} key={notification.id} onClick={onOpen}>
                                <p>{textFor(notification)}</p>
                                <div className="muted small">{new Date(notification.created_at).toLocaleDateString("pl-PL")}</div>
                            </button>
                        ) : (
                            <div className={className} key={notification.id}>
                                <p>{textFor(notification)}</p>
                                <div className="muted small">{new Date(notification.created_at).toLocaleDateString("pl-PL")}</div>
                            </div>
                        );
                    })
                )
            ) : (
                <>
                    <div className="card body-card">
                        <h3>Otrzymane zaproszenia</h3>
                        {incoming.length === 0 ? (
                            <p className="muted small">Nikt jeszcze nie zaprosił Cię do znajomych.</p>
                        ) : (
                            <div className="stack small-stack">
                                {incoming.map((request) => (
                                    <div className="person-row" key={request.requestId}>
                                        <Avatar id={request.id} name={request.name} avatarUrl={request.avatar} size="medium" />
                                        <div className="person-meta">
                                            <strong>{request.name}</strong>
                                        </div>
                                        <div className="chip-row">
                                            <button className="mini-button" onClick={() => onAccept(request.requestId, request.id)}>Akceptuj</button>
                                            <button className="ghost-button" onClick={() => onDecline(request.requestId)}>Odrzuć</button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="card body-card">
                        <h3>Wysłane zaproszenia</h3>
                        {outgoing.length === 0 ? (
                            <p className="muted small">Nie masz żadnych oczekujących zaproszeń.</p>
                        ) : (
                            <div className="stack small-stack">
                                {outgoing.map((request) => (
                                    <div className="person-row" key={request.requestId}>
                                        <Avatar id={request.id} name={request.name} avatarUrl={request.avatar} size="medium" />
                                        <div className="person-meta">
                                            <strong>{request.name}</strong>
                                        </div>
                                        <button className="ghost-button" onClick={() => onCancel(request.requestId)}>Cofnij</button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

// ETAP PO MVP 15 — "Podrzuć pomysł": formularz uproszczony względem
// AddIdeaScreen (bez ceny/priorytetu/komentarza — to tylko sugestia, odbiorca
// uzupełni resztę sam, jeśli zdecyduje się dodać ją do swoich pomysłów).
function SuggestIdeaScreen({
    friendName,
    onSubmit,
    error,
}: {
    friendName: string;
    onSubmit: (title: string, url: string, imageFile: File | null) => void;
    error?: string;
}) {
    const [title, setTitle] = useState("");
    const [url, setUrl] = useState("");
    const [imageFile, setImageFile] = useState<File | null>(null);
    const previewUrl = useMemo(() => (imageFile ? URL.createObjectURL(imageFile) : null), [imageFile]);
    useEffect(() => {
        return () => {
            if (previewUrl) URL.revokeObjectURL(previewUrl);
        };
    }, [previewUrl]);

    return (
        <div className="stack-form">
            <p className="muted">
                Wydaje Ci się, że {friendName} mogłoby się to spodobać? Podrzuć pomysł — {friendName} zobaczy zdjęcie,
                nazwę i link, i sam(a) zdecyduje, czy dodać go do swoich pomysłów.
            </p>

            <div className="field-group">
                <label>Zdjęcie (opcjonalnie)</label>
                {previewUrl ? (
                    <div className="idea-photo-preview">
                        <img src={previewUrl} alt="Podgląd" />
                        <button type="button" className="ghost-button" onClick={() => setImageFile(null)}>
                            Usuń zdjęcie
                        </button>
                    </div>
                ) : (
                    <label className="photo-upload-button">
                        + Dodaj zdjęcie
                        <input
                            type="file"
                            accept="image/*"
                            className="visually-hidden"
                            onChange={(event) => setImageFile(event.target.files?.[0] ?? null)}
                        />
                    </label>
                )}
            </div>

            <div className="field-group">
                <label>Nazwa</label>
                <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="np. Słuchawki Sony" />
            </div>

            <div className="field-group">
                <label>URL / link (opcjonalnie)</label>
                <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." />
            </div>

            {error ? <div className="error-box">{error}</div> : null}
            <button
                className="primary-button"
                disabled={!title.trim()}
                onClick={() => onSubmit(title, url, imageFile)}
            >
                Wyślij sugestię
            </button>
        </div>
    );
}

// ETAP PO MVP 17 — "Wspólne prezenty": lista planów, w których jestem
// uczestnikiem (zaproszony albo już dołączony) — nigdy plany dla WŁASNYCH
// pomysłów, bo te po prostu nie istnieją (RLS/RPC to blokują u źródła).
function GiftPlansScreen({
    plans,
    onSelectPlan,
    onRespond,
    namesById,
}: {
    plans: Array<{ plan: GiftPlanRow; myStatus: GiftPlanParticipantStatus; idea: Idea }>;
    onSelectPlan: (planId: string) => void;
    onRespond: (planId: string, accept: boolean) => void;
    namesById: Record<string, string>;
}) {
    return (
        <div className="stack">
            {plans.length === 0 ? (
                <div className="card body-card">
                    <p className="muted">
                        Nie organizujesz jeszcze żadnego prezentu wspólnie ze znajomymi. Otwórz pomysł znajomego i
                        wybierz „Zorganizujcie razem”.
                    </p>
                </div>
            ) : (
                plans.map(({ plan, myStatus, idea }) => (
                    <div className="card body-card" key={plan.id}>
                        <div className="row-between">
                            <strong>{idea.title}</strong>
                            <span className={myStatus === "invited" ? "status" : "status positive"}>
                                {myStatus === "invited" ? "Zaproszenie" : myStatus === "joined" ? "Dołączyłeś" : "Odrzucone"}
                            </span>
                        </div>
                        <p className="muted small">Dla: {namesById[idea.ownerId] ?? "Ktoś"}</p>
                        <p className="muted small">{idea.price ? `${idea.price} zł` : "Bez ceny"}</p>
                        {myStatus === "invited" ? (
                            <div className="chip-row">
                                <button className="mini-button" onClick={() => onRespond(plan.id, true)}>Dołączam</button>
                                <button className="ghost-button" onClick={() => onRespond(plan.id, false)}>Nie tym razem</button>
                            </div>
                        ) : (
                            <button className="secondary-button" onClick={() => onSelectPlan(plan.id)}>Zobacz szczegóły</button>
                        )}
                    </div>
                ))
            )}
        </div>
    );
}

function GiftPlanDetailScreen({
    plan,
    participants,
    myId,
    invitableFriends,
    onInvite,
    onRespond,
    chatMessages,
    chatDraft,
    onChatDraftChange,
    onSendChatMessage,
    namesById,
    error,
}: {
    plan: { plan: GiftPlanRow; myStatus: GiftPlanParticipantStatus; idea: Idea } | null;
    participants: Array<{ userId: string; name: string; avatar: string | null; status: GiftPlanParticipantStatus }>;
    myId: string;
    invitableFriends: Person[];
    onInvite: (userId: string) => void;
    onRespond: (accept: boolean) => void;
    chatMessages: ChatMessageRow[];
    chatDraft: string;
    onChatDraftChange: (value: string) => void;
    onSendChatMessage: () => void;
    namesById: Record<string, string>;
    error?: string;
}) {
    const [isInviting, setIsInviting] = useState(false);
    if (!plan) return null;

    const statusLabel: Record<GiftPlanParticipantStatus, string> = {
        invited: "Zaproszony(a)",
        joined: "Dołączył(a)",
        declined: "Zrezygnował(a)",
    };

    return (
        <div className="stack">
            <div className="card body-card">
                <p className="muted small">Dla: {namesById[plan.idea.ownerId] ?? "Ktoś"}</p>
                <strong>{plan.idea.title}</strong>
                <p className="muted small">{plan.idea.price ? `${plan.idea.price} zł` : "Bez ceny"}</p>
            </div>

            {plan.myStatus === "invited" ? (
                <div className="card body-card">
                    <p>Zostałeś(aś) zaproszony(a) do wspólnej organizacji tego prezentu.</p>
                    <div className="chip-row">
                        <button className="mini-button" onClick={() => onRespond(true)}>Dołączam</button>
                        <button className="ghost-button" onClick={() => onRespond(false)}>Nie tym razem</button>
                    </div>
                </div>
            ) : null}

            <div className="card body-card">
                <h3>Uczestnicy</h3>
                <div className="stack small-stack">
                    {participants.map((participant) => (
                        <div className="list-row" key={participant.userId}>
                            <span>{participant.userId === myId ? `${participant.name} (Ty)` : participant.name}</span>
                            <span className={participant.status === "joined" ? "status positive" : "status"}>
                                {statusLabel[participant.status]}
                            </span>
                        </div>
                    ))}
                </div>
            </div>

            {error ? <div className="error-box">{error}</div> : null}

            {plan.myStatus === "joined" ? (
                <div className="card body-card">
                    <h3>Zaproś kolejną osobę</h3>
                    {isInviting ? (
                        invitableFriends.length === 0 ? (
                            <p className="muted small">Nie masz już kogo dodatkowo zaprosić.</p>
                        ) : (
                            <div className="chip-row wrap">
                                {invitableFriends.map((friend) => (
                                    <button
                                        key={friend.id}
                                        className="chip"
                                        onClick={() => {
                                            onInvite(friend.id);
                                            setIsInviting(false);
                                        }}
                                    >
                                        {friend.name}
                                    </button>
                                ))}
                            </div>
                        )
                    ) : (
                        <button className="mini-button" onClick={() => setIsInviting(true)}>+ Zaproś</button>
                    )}
                </div>
            ) : null}

            {plan.myStatus === "joined" ? (
                <div className="card body-card">
                    <h3>💬 Czat</h3>
                    <div className="chat-log">
                        {chatMessages.length === 0 ? (
                            <p className="muted small">Bez wiadomości — napisz pierwszy.</p>
                        ) : (
                            chatMessages.map((message) => (
                                <div
                                    key={message.id}
                                    className={message.sender_id === myId ? "chat-message chat-message-mine" : "chat-message"}
                                >
                                    {message.sender_id !== myId ? (
                                        <div className="chat-message-sender">{namesById[message.sender_id] ?? "Ktoś"}</div>
                                    ) : null}
                                    <div className="chat-message-bubble">{message.message}</div>
                                </div>
                            ))
                        )}
                    </div>
                    <div className="chat-input-row">
                        <input
                            value={chatDraft}
                            onChange={(event) => onChatDraftChange(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && chatDraft.trim()) onSendChatMessage();
                            }}
                            placeholder="Napisz wiadomość..."
                        />
                        <button className="mini-button" onClick={onSendChatMessage} disabled={!chatDraft.trim()}>
                            Wyślij
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

// ETAP 8 — Okazje: lista własnych + prosty formularz dodawania (imię,
// prawdziwa data, widoczność jak przy pomysłach — tylko ja / grupa /
// wszyscy znajomi, ale bez wielu grup naraz, bo occasions.group_id to
// pojedyncza kolumna, nie tabela join jak idea_visibility).
function OccasionsScreen({
    occasions,
    groups,
    onAdd,
    onDelete,
    error,
}: {
    occasions: Array<OccasionRow & { daysUntil: number }>;
    groups: Array<{ id: string; name: string }>;
    onAdd: (name: string, date: string, groupId: string | null) => void;
    onDelete: (id: string) => void;
    error?: string;
}) {
    const [name, setName] = useState("");
    const [date, setDate] = useState("");
    const [groupId, setGroupId] = useState<string | null>(null);

    const handleAdd = () => {
        onAdd(name, date, groupId);
        setName("");
        setDate("");
        setGroupId(null);
    };

    return (
        <div className="stack">
            <div className="card body-card">
                <h3>Twoje okazje</h3>
                {occasions.length === 0 ? (
                    <p className="muted small">Nie masz jeszcze żadnych okazji.</p>
                ) : (
                    <div className="stack small-stack">
                        {occasions.map((occasion) => (
                            <div className="list-row" key={occasion.id}>
                                <span>🎂 {occasion.name}</span>
                                <span className="badge">za {occasion.daysUntil} dni</span>
                                <button className="ghost-button" onClick={() => onDelete(occasion.id)}>Usuń</button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="card body-card">
                <h3>Dodaj okazję</h3>
                <div className="field-group">
                    <label>Nazwa</label>
                    <input value={name} onChange={(event) => setName(event.target.value)} placeholder="np. Urodziny" />
                </div>
                <div className="field-group">
                    <label>Data</label>
                    <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
                </div>
                <div className="field-group">
                    <label>Widoczność</label>
                    <div className="chip-row wrap">
                        <button className={groupId === null ? "chip active" : "chip"} onClick={() => setGroupId(null)}>
                            🌍 Wszyscy znajomi
                        </button>
                        {groups.map((group) => (
                            <button
                                key={group.id}
                                className={groupId === group.id ? "chip active" : "chip"}
                                onClick={() => setGroupId(group.id)}
                            >
                                {group.name}
                            </button>
                        ))}
                    </div>
                </div>
                {error ? <div className="error-box">{error}</div> : null}
                <button className="primary-button" onClick={handleAdd} disabled={!name.trim() || !date}>
                    Dodaj okazję
                </button>
            </div>
        </div>
    );
}

// ETAP 19 — Ankiety. Tworzy nową ankietę dla wskazanego znajomego (target) —
// jeśli target próbowałby stworzyć ankietę o sobie, RLS i tak by to
// zablokowało (check target_id <> created_by), ale UI po prostu nie daje tu
// wyboru "dla siebie", więc problem nie powstaje.
function CreatePollScreen({
    friendName,
    groups,
    onSubmit,
    error,
}: {
    friendName: string;
    groups: Array<{ id: string; name: string }>;
    onSubmit: (question: string, options: string[], groupId: string | null) => void;
    error?: string;
}) {
    const [question, setQuestion] = useState("");
    const [options, setOptions] = useState(["", ""]);
    const [groupId, setGroupId] = useState<string | null>(null);

    const updateOption = (index: number, value: string) => {
        setOptions((prev) => prev.map((option, i) => (i === index ? value : option)));
    };

    const canSubmit = question.trim() && options.filter((option) => option.trim()).length >= 2;

    return (
        <div className="stack-form">
            <p className="muted">Zapytaj wspólnych znajomych, co kupić dla {friendName} — {friendName} nigdy nie zobaczy tej ankiety.</p>

            <div className="field-group">
                <label>Pytanie</label>
                <input
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    placeholder={`Co kupujemy ${friendName}?`}
                />
            </div>

            <div className="field-group">
                <label>Opcje</label>
                {options.map((option, index) => (
                    <input
                        key={index}
                        value={option}
                        onChange={(event) => updateOption(index, event.target.value)}
                        placeholder={`Opcja ${index + 1}`}
                        style={{ marginTop: index > 0 ? "8px" : undefined }}
                    />
                ))}
                <button className="text-button" onClick={() => setOptions((prev) => [...prev, ""])}>
                    + Dodaj opcję
                </button>
            </div>

            <div className="field-group">
                <label>Widoczność</label>
                <div className="chip-row wrap">
                    <button className={groupId === null ? "chip active" : "chip"} onClick={() => setGroupId(null)}>
                        🌍 Wszyscy wspólni znajomi
                    </button>
                    {groups.map((group) => (
                        <button
                            key={group.id}
                            className={groupId === group.id ? "chip active" : "chip"}
                            onClick={() => setGroupId(group.id)}
                        >
                            {group.name}
                        </button>
                    ))}
                </div>
            </div>

            {error ? <div className="error-box">{error}</div> : null}
            <button
                className="primary-button"
                disabled={!canSubmit}
                onClick={() => onSubmit(question, options, groupId)}
            >
                Utwórz ankietę
            </button>
        </div>
    );
}

function PollsScreen({
    polls,
    onSelectPoll,
}: {
    polls: Array<{ poll: PollRow; targetName: string; options: Array<PollOptionRow & { voteCount: number }>; myOptionId: string | null }>;
    onSelectPoll: (pollId: string) => void;
}) {
    return (
        <div className="stack">
            {polls.length === 0 ? (
                <div className="card body-card">
                    <p className="muted">Brak ankiet — stwórz jedną z profilu znajomego.</p>
                </div>
            ) : (
                polls.map(({ poll, targetName, options }) => {
                    const totalVotes = options.reduce((sum, option) => sum + option.voteCount, 0);
                    return (
                        <button className="card body-card summary-link" key={poll.id} onClick={() => onSelectPoll(poll.id)}>
                            <div>
                                <div className="eyebrow">Dla {targetName}</div>
                                <h3>{poll.question}</h3>
                            </div>
                            <span className="badge">{totalVotes} {polishPlural(totalVotes, ["głos", "głosy", "głosów"])} →</span>
                        </button>
                    );
                })
            )}
        </div>
    );
}

function PollDetailScreen({
    poll,
    onVote,
}: {
    poll: { poll: PollRow; targetName: string; options: Array<PollOptionRow & { voteCount: number }>; myOptionId: string | null } | null;
    onVote: (optionId: string) => void;
}) {
    if (!poll) return null;
    const totalVotes = poll.options.reduce((sum, option) => sum + option.voteCount, 0);

    return (
        <div className="stack">
            <div className="card body-card">
                <div className="eyebrow">Dla {poll.targetName}</div>
                <h2>{poll.poll.question}</h2>
                <div className="stack small-stack" style={{ marginTop: "14px" }}>
                    {poll.options.map((option) => {
                        const isMine = option.id === poll.myOptionId;
                        const percent = totalVotes > 0 ? Math.round((option.voteCount / totalVotes) * 100) : 0;
                        return (
                            <button
                                key={option.id}
                                className={isMine ? "list-row clickable-row poll-option poll-option-mine" : "list-row clickable-row poll-option"}
                                onClick={() => onVote(option.id)}
                            >
                                <span>{isMine ? "✓ " : ""}{option.label}</span>
                                <span className="muted small">{option.voteCount} ({percent}%)</span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

function PeopleScreen({
    people,
    groups,
    tab,
    onTabChange,
    onSelectFriend,
    onAddFriend,
    onAddGroup,
    onInvite,
    onToggleGroupReservations,
}: {
    people: Array<{
        id: string;
        name: string;
        avatar: string | null;
        birthday: string;
        birthdayIn: number;
        relation: string;
        groups: string[];
    }>;
    groups: Array<{
        id: string;
        name: string;
        description: string;
        isOwner: boolean;
        reservationsEnabled: boolean;
        members: Person[];
    }>;
    tab: "znajomi" | "grupy";
    onTabChange: (tab: "znajomi" | "grupy") => void;
    onSelectFriend: (id: string) => void;
    onAddFriend: () => void;
    onAddGroup: (values: { name: string; members: string[] }) => void;
    onInvite: (groupId: string, personId: string) => void;
    onToggleGroupReservations: (groupId: string, next: boolean) => void;
}) {
    const [groupDraft, setGroupDraft] = useState({ name: "", members: [] as string[] });
    const [showAddGroupForm, setShowAddGroupForm] = useState(false);
    const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
    const [invitingGroupId, setInvitingGroupId] = useState<string | null>(null);

    const submitGroup = () => {
        onAddGroup(groupDraft);
        setGroupDraft({ name: "", members: [] });
        setShowAddGroupForm(false);
    };

    return (
        <div className="stack">
            <div className="tab-row">
                <button className={tab === "znajomi" ? "tab-button active" : "tab-button"} onClick={() => onTabChange("znajomi")}>
                    Znajomi
                </button>
                <button className={tab === "grupy" ? "tab-button active" : "tab-button"} onClick={() => onTabChange("grupy")}>
                    Grupy
                </button>
            </div>

            {tab === "znajomi" ? (
                <>
                    <div className="section-header compact-header">
                        <h2>Znajomi</h2>
                        <button className="mini-button" onClick={onAddFriend}>+ Dodaj znajomego</button>
                    </div>

                    {people.length === 0 ? (
                        <div className="card body-card">
                            <p>Nie masz jeszcze żadnych znajomych. Dodaj kogoś przyciskiem powyżej.</p>
                        </div>
                    ) : null}

                    {people.map((person) => (
                        <button key={person.id} className="person-row" onClick={() => onSelectFriend(person.id)}>
                            <Avatar id={person.id} name={person.name} avatarUrl={person.avatar} size="medium" />
                            <div className="person-meta">
                                <strong>{person.name}</strong>
                                <span>{person.relation}</span>
                            </div>
                            <span className="badge">🎂 {person.birthday}</span>
                        </button>
                    ))}
                </>
            ) : (
                <>
                    <div className="section-header compact-header">
                        <h2>Grupy</h2>
                        <button className="mini-button" onClick={() => setShowAddGroupForm((prev) => !prev)}>
                            {showAddGroupForm ? "Anuluj" : "+ Dodaj grupę"}
                        </button>
                    </div>

                    {showAddGroupForm ? (
                        <div className="card body-card inline-form">
                            <div className="field-group">
                                <label>Nazwa grupy</label>
                                <input
                                    value={groupDraft.name}
                                    onChange={(event) => setGroupDraft({ ...groupDraft, name: event.target.value })}
                                    placeholder="np. Rodzina / Koleżeńska / Padel"
                                />
                            </div>
                            <div className="field-group">
                                <label>Wybierz znajomych</label>
                                <div className="chip-row wrap">
                                    {people.map((person) => {
                                        const active = groupDraft.members.includes(person.id);
                                        return (
                                            <button
                                                key={person.id}
                                                className={active ? "chip active" : "chip"}
                                                onClick={() => {
                                                    setGroupDraft((prev) => ({
                                                        ...prev,
                                                        members: active
                                                            ? prev.members.filter((id) => id !== person.id)
                                                            : [...prev.members, person.id],
                                                    }));
                                                }}
                                            >
                                                {person.name}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                            <button className="primary-button" onClick={submitGroup}>Utwórz grupę</button>
                        </div>
                    ) : null}

                    {groups.length === 0 ? (
                        <div className="card body-card">
                            <p>Nie masz jeszcze żadnych grup. Utwórz pierwszą powyżej.</p>
                        </div>
                    ) : null}

                    {groups.map((group) => {
                        const isExpanded = expandedGroupId === group.id;
                        const isInviting = invitingGroupId === group.id;
                        const invitablePeople = people.filter(
                            (person) => !group.members.some((member) => member.id === person.id)
                        );

                        return (
                            <div className="card body-card" key={group.id}>
                                <div className="list-row">
                                    <span>👥 {group.name}</span>
                                    <span className="badge">{group.members.length} {personWord(group.members.length)}</span>
                                </div>
                                {group.description ? <p>{group.description}</p> : null}

                                <div className="toggle-row">
                                    <span>Rezerwacje w tej grupie</span>
                                    {group.isOwner ? (
                                        <button
                                            className={group.reservationsEnabled ? "toggle on" : "toggle"}
                                            onClick={() => onToggleGroupReservations(group.id, !group.reservationsEnabled)}
                                        >
                                            {group.reservationsEnabled ? "Włączone" : "Wyłączone"}
                                        </button>
                                    ) : (
                                        <span className={group.reservationsEnabled ? "status positive" : "status"}>
                                            {group.reservationsEnabled ? "Włączone" : "Wyłączone"}
                                        </span>
                                    )}
                                </div>

                                {isExpanded ? (
                                    <div className="stack small-stack">
                                        {group.members.map((member) => (
                                            <div className="list-row" key={member.id}>
                                                <span>{member.name}</span>
                                            </div>
                                        ))}
                                    </div>
                                ) : null}

                                {isInviting ? (
                                    <div className="chip-row wrap">
                                        {invitablePeople.length === 0 ? (
                                            <span className="muted small">Wszyscy znajomi są już w tej grupie.</span>
                                        ) : (
                                            invitablePeople.map((person) => (
                                                <button
                                                    key={person.id}
                                                    className="chip"
                                                    onClick={() => {
                                                        onInvite(group.id, person.id);
                                                        setInvitingGroupId(null);
                                                    }}
                                                >
                                                    {person.name}
                                                </button>
                                            ))
                                        )}
                                    </div>
                                ) : null}

                                <div className="mini-actions">
                                    {group.isOwner ? (
                                        <button
                                            className="mini-button"
                                            onClick={() => setInvitingGroupId(isInviting ? null : group.id)}
                                        >
                                            {isInviting ? "Anuluj" : "Zaproś"}
                                        </button>
                                    ) : null}
                                    <button
                                        className="mini-button"
                                        onClick={() => setExpandedGroupId(isExpanded ? null : group.id)}
                                    >
                                        {isExpanded ? "Ukryj członków" : "Pokaż członków"}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </>
            )}
        </div>
    );
}

function AddFriendScreen({
    candidates,
    onSendRequest,
    onAcceptRequest,
    inviteCode,
    onRegenerateInvite,
}: {
    candidates: Array<{
        id: string;
        name: string;
        avatar: string | null;
        status: "none" | "outgoing" | "incoming";
        incomingRequestId: string | null;
    }>;
    onSendRequest: (id: string) => void;
    onAcceptRequest: (requestId: string, senderId: string) => void;
    inviteCode: string | null;
    onRegenerateInvite: () => void;
}) {
    const [query, setQuery] = useState("");
    const [sentIds, setSentIds] = useState<string[]>([]);

    const filtered = query.trim()
        ? candidates.filter((person) => person.name.toLowerCase().includes(query.trim().toLowerCase()))
        : [];

    const inviteUrl = inviteCode && typeof window !== "undefined" ? `${window.location.origin}/invite/${inviteCode}` : "";
    const shareMessage = "Dołącz do moich ludzi na Widoczku i zobacz, co chciałbym dostać 🎁";
    const canShare = typeof navigator !== "undefined" && "share" in navigator;

    const handleSend = (id: string) => {
        onSendRequest(id);
        setSentIds((prev) => [...prev, id]);
    };

    const handleShare = () => {
        if (canShare) {
            navigator.share({ title: "WhishApp", text: shareMessage, url: inviteUrl }).catch(() => {});
        }
    };

    const handleCopy = () => {
        if (typeof navigator !== "undefined" && navigator.clipboard) {
            void navigator.clipboard.writeText(inviteUrl);
        }
    };

    return (
        <div className="stack">
            <div className="card body-card">
                <h3>Wyszukaj znajomego</h3>
                <div className="field-group">
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Wpisz imię i nazwisko"
                    />
                </div>
                {query.trim() && filtered.length === 0 ? (
                    <p className="muted small">Nikogo nie znaleziono — może trzeba go zaprosić linkiem poniżej.</p>
                ) : null}
                <div className="stack small-stack">
                    {filtered.map((person) => (
                        <div className="person-row" key={person.id}>
                            <Avatar id={person.id} name={person.name} avatarUrl={person.avatar} size="medium" />
                            <div className="person-meta">
                                <strong>{person.name}</strong>
                            </div>
                            {person.status === "incoming" && person.incomingRequestId ? (
                                <button className="mini-button" onClick={() => onAcceptRequest(person.incomingRequestId!, person.id)}>
                                    Akceptuj
                                </button>
                            ) : sentIds.includes(person.id) || person.status === "outgoing" ? (
                                <span className="status">Zaproszono</span>
                            ) : (
                                <button className="mini-button" onClick={() => handleSend(person.id)}>Zaproś</button>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            <div className="card body-card">
                <h3>Albo zaproś linkiem</h3>
                <p>Wyślij ten link znajomemu — jeśli nie ma jeszcze konta, założy je i od razu zostaniecie połączeni.</p>
                {inviteUrl ? (
                    <>
                        <div className="field-group">
                            <input value={inviteUrl} readOnly onFocus={(event) => event.target.select()} />
                        </div>
                        <div className="chip-row wrap">
                            {canShare ? (
                                <button className="chip" onClick={handleShare}>📤 Udostępnij</button>
                            ) : null}
                            <button className="chip" onClick={handleCopy}>📋 Kopiuj link</button>
                            <a
                                className="chip"
                                href={`https://wa.me/?text=${encodeURIComponent(`${shareMessage} ${inviteUrl}`)}`}
                                target="_blank"
                                rel="noreferrer"
                            >
                                WhatsApp
                            </a>
                            <a className="chip" href={`sms:?body=${encodeURIComponent(`${shareMessage} ${inviteUrl}`)}`}>
                                SMS
                            </a>
                        </div>
                        <button className="secondary-button" onClick={onRegenerateInvite}>Wygeneruj nowy link</button>
                    </>
                ) : (
                    <p className="muted">Generowanie linku...</p>
                )}
            </div>
        </div>
    );
}

function FriendRequestsScreen({
    incoming,
    outgoing,
    onAccept,
    onDecline,
    onCancel,
}: {
    incoming: Array<{ requestId: string; id: string; name: string; avatar: string | null }>;
    outgoing: Array<{ requestId: string; id: string; name: string; avatar: string | null }>;
    onAccept: (requestId: string, senderId: string) => void;
    onDecline: (requestId: string) => void;
    onCancel: (requestId: string) => void;
}) {
    return (
        <div className="stack">
            <div className="card body-card">
                <h3>Otrzymane zaproszenia</h3>
                {incoming.length === 0 ? (
                    <p className="muted small">Nikt jeszcze nie zaprosił Cię do znajomych.</p>
                ) : (
                    <div className="stack small-stack">
                        {incoming.map((request) => (
                            <div className="person-row" key={request.requestId}>
                                <Avatar id={request.id} name={request.name} avatarUrl={request.avatar} size="medium" />
                                <div className="person-meta">
                                    <strong>{request.name}</strong>
                                </div>
                                <div className="chip-row">
                                    <button className="mini-button" onClick={() => onAccept(request.requestId, request.id)}>Akceptuj</button>
                                    <button className="ghost-button" onClick={() => onDecline(request.requestId)}>Odrzuć</button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="card body-card">
                <h3>Wysłane zaproszenia</h3>
                {outgoing.length === 0 ? (
                    <p className="muted small">Nie masz żadnych oczekujących zaproszeń.</p>
                ) : (
                    <div className="stack small-stack">
                        {outgoing.map((request) => (
                            <div className="person-row" key={request.requestId}>
                                <Avatar id={request.id} name={request.name} avatarUrl={request.avatar} size="medium" />
                                <div className="person-meta">
                                    <strong>{request.name}</strong>
                                </div>
                                <button className="ghost-button" onClick={() => onCancel(request.requestId)}>Cofnij</button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

// ETAP PO MVP 16 — "Znajdź prezent": czysto klienckie zawężanie już
// wczytanych pomysłów znajomego wg budżetu. Bez rekomendacji/produktów
// powiązanych — te są celowo odłożone (patrz instrukcja.txt i monetyzacja.txt,
// żeby nie budować monetyzacji przed czasem).
function GiftsScreen({
    people,
    onSelectFriend,
    friendIdeasByPersonId,
    onSelectIdea,
    occasions,
}: {
    people: Array<{
        id: string;
        name: string;
        avatar: string | null;
        birthday: string;
        birthdayIn: number;
        relation: string;
        groups: string[];
    }>;
    onSelectFriend: (id: string) => void;
    friendIdeasByPersonId: Record<string, Idea[]>;
    onSelectIdea: (friendId: string, ideaId: string) => void;
    occasions: Array<{ id: string; name: string; ownerName: string; owner_id: string; daysUntil: number }>;
}) {
    const [findGiftFriendId, setFindGiftFriendId] = useState<string | null>(null);
    const [budget, setBudget] = useState("");

    const results = useMemo(() => {
        if (!findGiftFriendId) return [];
        const ideas = friendIdeasByPersonId[findGiftFriendId] ?? [];
        const maxBudget = budget.trim() ? Number(budget) : null;
        const filtered = maxBudget != null && !Number.isNaN(maxBudget) ? ideas.filter((idea) => idea.price != null && idea.price <= maxBudget) : ideas;
        const priorityOrder: Record<Priority, number> = { bardzo: 0, chce: 1, moze: 2 };
        return [...filtered].sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
    }, [findGiftFriendId, friendIdeasByPersonId, budget]);

    return (
        <div className="stack">
            <div className="card body-card">
                <h3>🎁 Znajdź prezent</h3>
                <div className="field-group">
                    <label>Dla kogo?</label>
                    <div className="chip-row wrap">
                        {people.map((person) => (
                            <button
                                key={person.id}
                                className={findGiftFriendId === person.id ? "chip active" : "chip"}
                                onClick={() => setFindGiftFriendId(findGiftFriendId === person.id ? null : person.id)}
                            >
                                {person.name}
                            </button>
                        ))}
                    </div>
                </div>
                {findGiftFriendId ? (
                    <div className="field-group">
                        <label>Budżet (opcjonalnie)</label>
                        <input value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="np. 300" />
                    </div>
                ) : null}

                {findGiftFriendId ? (
                    results.length === 0 ? (
                        <p className="muted small">Brak widocznych pomysłów w tym budżecie.</p>
                    ) : (
                        <div className="stack small-stack">
                            {results.map((idea) => (
                                <button
                                    key={idea.id}
                                    className="list-row clickable-row"
                                    onClick={() => onSelectIdea(findGiftFriendId, idea.id)}
                                >
                                    <span>{priorityMeta[idea.priority].emoji} {idea.title}</span>
                                    <span className="muted small">{idea.price ? `${idea.price} zł` : "bez ceny"}</span>
                                </button>
                            ))}
                        </div>
                    )
                ) : null}
            </div>

            {occasions.length > 0 ? (
                <div className="card body-card">
                    <h3>Nadchodzące okazje</h3>
                    <div className="stack small-stack">
                        {occasions.slice(0, 8).map((occasion) => (
                            <button
                                key={occasion.id}
                                className="list-row clickable-row"
                                onClick={() => onSelectFriend(occasion.owner_id)}
                            >
                                <span>🎂 {occasion.ownerName} — {occasion.name}</span>
                                <span className="badge">za {occasion.daysUntil} dni</span>
                            </button>
                        ))}
                    </div>
                </div>
            ) : null}

            <div className="card body-card">
                <h3>Nadchodzące urodziny</h3>
                {people.length === 0 ? (
                    <p className="muted">Brak znajomych do pokazania.</p>
                ) : (
                    <div className="stack small-stack">
                        {people.map((person) => (
                            <button key={person.id} className="list-row clickable-row" onClick={() => onSelectFriend(person.id)}>
                                <span>{person.name}</span>
                                <span className="badge">🎂 {person.birthday}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function ProfileScreen({
    friend,
    currentUser,
    friendIdeas,
    myReservedIdeas,
    onOpenPrivacy,
    onEditProfile,
    onBackToPeople,
    onLogout,
    onSelectIdea,
    onSelectReservedIdea,
    onOpenPriority,
    onViewMyIdeas,
    archivedCount,
    onOpenArchive,
    onSuggestIdea,
    giftPlansCount,
    onOpenGiftPlans,
    occasionsCount,
    onOpenOccasions,
    onCreatePoll,
    pollsCount,
    onOpenPolls,
}: {
    friend: Person;
    currentUser: Person;
    friendIdeas: Idea[];
    myReservedIdeas?: Array<{ reservationId: string; reservationStatus: "reserved" | "purchased" | "cancelled" | "completed"; idea: Idea; ownerName: string }>;
    onOpenPrivacy: () => void;
    onEditProfile?: () => void;
    onBackToPeople: () => void;
    onLogout?: () => void;
    onSelectIdea: (ideaId: string) => void;
    onSelectReservedIdea?: (ownerId: string, ideaId: string) => void;
    onOpenPriority: (priority: string) => void;
    onViewMyIdeas?: () => void;
    archivedCount?: number;
    onOpenArchive?: () => void;
    onSuggestIdea?: () => void;
    giftPlansCount?: number;
    onOpenGiftPlans?: () => void;
    occasionsCount?: number;
    onOpenOccasions?: () => void;
    onCreatePoll?: () => void;
    pollsCount?: number;
    onOpenPolls?: () => void;
}) {
    const isMe = friend.id === currentUser.id;

    return (
        <div className="stack">
            <div className="card body-card profile-card">
                <Avatar
                    id={isMe ? currentUser.id : friend.id}
                    name={isMe ? currentUser.name : friend.name}
                    avatarUrl={isMe ? currentUser.avatar : friend.avatar}
                    size="large"
                />
                <div className="profile-label-row">
                    <span className="profile-label">{isMe ? "Twój profil" : "Profil znajomego"}</span>
                </div>
                <h2>{isMe ? currentUser.name : friend.name}</h2>
                <div className="badge-row">
                    <span className="badge">🎂 {isMe ? currentUser.birthday : friend.birthday}</span>
                    <span className="badge">{friendIdeas.length} {ideaWord(friendIdeas.length)}</span>
                </div>
            </div>

            {isMe ? (
                <button className="card body-card summary-link" onClick={onViewMyIdeas}>
                    <div>
                        <div className="eyebrow">Twoje pomysły</div>
                        <h3>Moje aktywne pomysły</h3>
                    </div>
                    <span className="badge">{friendIdeas.length} {ideaWord(friendIdeas.length)} →</span>
                </button>
            ) : (
                <div className="card body-card">
                    <h3>Co chciałby dostać</h3>
                    <div className="stack small-stack">
                        {friendIdeas.map((idea) => (
                            <button key={idea.id} className="list-row clickable-row" onClick={() => onSelectIdea(idea.id)}>
                                <span>{idea.title}</span>
                                <span className="priority tiny">{priorityMeta[idea.priority].emoji}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {!isMe ? (
                <div className="card body-card">
                    <h3>Priorytety</h3>
                    <div className="stack small-stack">
                        <button className="list-row clickable-row" onClick={() => onOpenPriority("bardzo")}>
                            <span>🔥 Bardzo chcę</span>
                            <span className="badge">{friendIdeas.filter((idea) => idea.priority === "bardzo").length}</span>
                        </button>
                        <button className="list-row clickable-row" onClick={() => onOpenPriority("chce")}>
                            <span>❤️ Chcę</span>
                            <span className="badge">{friendIdeas.filter((idea) => idea.priority === "chce").length}</span>
                        </button>
                        <button className="list-row clickable-row" onClick={() => onOpenPriority("moze")}>
                            <span>🤷 Może kiedyś</span>
                            <span className="badge">{friendIdeas.filter((idea) => idea.priority === "moze").length}</span>
                        </button>
                    </div>
                </div>
            ) : null}

            {isMe && myReservedIdeas && myReservedIdeas.length > 0 ? (
                <div className="card body-card">
                    <h3>Prezenty, które kupujesz</h3>
                    <div className="stack small-stack">
                        {myReservedIdeas.map(({ reservationId, reservationStatus, idea, ownerName }) => (
                            <button
                                key={reservationId}
                                className="list-row clickable-row"
                                onClick={() => onSelectReservedIdea?.(idea.ownerId, idea.id)}
                            >
                                <span>{idea.title} — dla {ownerName}</span>
                                <span className="badge">{reservationStatus === "purchased" ? "✓ Kupione" : "🎁 Zarezerwowane"}</span>
                            </button>
                        ))}
                    </div>
                </div>
            ) : null}

            {isMe && onOpenArchive ? (
                <button className="card body-card summary-link" onClick={onOpenArchive}>
                    <div>
                        <div className="eyebrow">Otrzymane</div>
                        <h3>Archiwum</h3>
                    </div>
                    <span className="badge">{archivedCount ?? 0} {ideaWord(archivedCount ?? 0)} →</span>
                </button>
            ) : null}

            {isMe && onOpenGiftPlans ? (
                <button className="card body-card summary-link" onClick={onOpenGiftPlans}>
                    <div>
                        <div className="eyebrow">Razem ze znajomymi</div>
                        <h3>Wspólne prezenty</h3>
                    </div>
                    <span className="badge">{giftPlansCount ?? 0} {ideaWord(giftPlansCount ?? 0)} →</span>
                </button>
            ) : null}

            {isMe && onOpenOccasions ? (
                <button className="card body-card summary-link" onClick={onOpenOccasions}>
                    <div>
                        <div className="eyebrow">Urodziny i wydarzenia</div>
                        <h3>Okazje</h3>
                    </div>
                    <span className="badge">{occasionsCount ?? 0} {polishPlural(occasionsCount ?? 0, ["okazja", "okazje", "okazji"])} →</span>
                </button>
            ) : null}

            {isMe && onOpenPolls ? (
                <button className="card body-card summary-link" onClick={onOpenPolls}>
                    <div>
                        <div className="eyebrow">Co komu kupić</div>
                        <h3>Ankiety</h3>
                    </div>
                    <span className="badge">{pollsCount ?? 0} {polishPlural(pollsCount ?? 0, ["ankieta", "ankiety", "ankiet"])} →</span>
                </button>
            ) : null}

            {!isMe && onSuggestIdea ? (
                <button className="secondary-button" onClick={onSuggestIdea}>💡 Podrzuć pomysł</button>
            ) : null}

            {!isMe && onCreatePoll ? (
                <button className="secondary-button" onClick={onCreatePoll}>📊 Stwórz ankietę</button>
            ) : null}

            {isMe ? (
                <>
                    {onEditProfile ? (
                        <button className="secondary-button" onClick={onEditProfile}>Edytuj profil</button>
                    ) : null}
                    <button className="secondary-button" onClick={onOpenPrivacy}>Ustawienia prywatności</button>
                    {onLogout ? (
                        <button className="secondary-button danger-button" onClick={onLogout}>Wyloguj się</button>
                    ) : null}
                </>
            ) : (
                <button className="secondary-button back-button" onClick={onBackToPeople}>
                    <IconArrowLeft className="back-button-icon" />
                    Wróć do ludzi
                </button>
            )}
        </div>
    );
}

function EditProfileScreen({
    me,
    email,
    onSaveProfile,
    onUploadAvatar,
    onRemoveAvatar,
    onChangeEmail,
    onChangePassword,
    error,
    info,
}: {
    me: Person;
    email: string;
    onSaveProfile: (values: { fullName: string; city: string; birthday: string }) => void;
    onUploadAvatar: (file: File) => void;
    onRemoveAvatar: () => void;
    onChangeEmail: (value: string) => void;
    onChangePassword: (value: string) => void;
    error?: string;
    info?: string;
}) {
    const [fullName, setFullName] = useState(me.name);
    const [city, setCity] = useState(me.city ?? "");
    const [birthday, setBirthday] = useState(me.birthday);
    const [newEmail, setNewEmail] = useState(email);
    const [newPassword, setNewPassword] = useState("");

    return (
        <div className="stack">
            <div className="card body-card profile-card">
                <Avatar id={me.id} name={me.name} avatarUrl={me.avatar} size="large" />
                <div className="chip-row" style={{ justifyContent: "center", marginTop: "14px" }}>
                    <label className="chip" style={{ cursor: "pointer" }}>
                        Zmień zdjęcie
                        <input
                            type="file"
                            accept="image/*"
                            style={{ display: "none" }}
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (file) onUploadAvatar(file);
                                event.target.value = "";
                            }}
                        />
                    </label>
                    {me.avatar ? (
                        <button className="chip" onClick={onRemoveAvatar}>Usuń zdjęcie</button>
                    ) : null}
                </div>
                <p className="muted small" style={{ marginTop: "10px" }}>
                    Bez zdjęcia pokazujemy Twoje inicjały na kolorowym tle.
                </p>
            </div>

            <div className="card body-card">
                <h3>Twoje dane</h3>
                <div className="field-group">
                    <label>Imię i nazwisko</label>
                    <input value={fullName} onChange={(event) => setFullName(event.target.value)} />
                </div>
                <div className="two-col">
                    <div className="field-group">
                        <label>Miasto</label>
                        <input value={city} onChange={(event) => setCity(event.target.value)} placeholder="Warszawa" />
                    </div>
                    <div className="field-group">
                        <label>Urodziny</label>
                        <input value={birthday} onChange={(event) => setBirthday(event.target.value)} placeholder="np. 12 marca" />
                    </div>
                </div>
                <button className="primary-button" onClick={() => onSaveProfile({ fullName, city, birthday })}>
                    Zapisz dane
                </button>
            </div>

            <div className="card body-card">
                <h3>Adres e-mail</h3>
                <div className="field-group">
                    <label>Nowy e-mail</label>
                    <input type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} />
                </div>
                <button className="secondary-button" onClick={() => onChangeEmail(newEmail)}>Zmień e-mail</button>
            </div>

            <div className="card body-card">
                <h3>Hasło</h3>
                <div className="field-group">
                    <label>Nowe hasło</label>
                    <input
                        type="password"
                        value={newPassword}
                        onChange={(event) => setNewPassword(event.target.value)}
                        placeholder="••••••••"
                    />
                </div>
                <button
                    className="secondary-button"
                    onClick={() => {
                        onChangePassword(newPassword);
                        setNewPassword("");
                    }}
                >
                    Zmień hasło
                </button>
            </div>

            {info ? <div className="status positive">{info}</div> : null}
            {error ? <div className="error-box">{error}</div> : null}
        </div>
    );
}

function PrivacyScreen({
    onManageGroups,
    reservationsEnabled,
    onToggleReservations,
    onDeleteAccount,
    error,
}: {
    onManageGroups: () => void;
    reservationsEnabled: boolean;
    onToggleReservations: (next: boolean) => void;
    onDeleteAccount: () => void;
    error?: string;
}) {
    return (
        <div className="stack">
            <div className="card body-card">
                <h3>Kontrola prywatności</h3>
                <div className="stack small-stack">
                    <div className="toggle-row">
                        <span>Widoczność pomysłów</span>
                        <span className="status positive">Ustawiana per pomysł</span>
                    </div>
                    <div className="toggle-row">
                        <span>Ukryj rezerwacje przed właścicielem</span>
                        <span className="status positive">Zawsze włączone</span>
                    </div>
                    <div className="toggle-row">
                        <span>Rezerwacje pomysłów (wszystkie)</span>
                        <button
                            className={reservationsEnabled ? "toggle on" : "toggle"}
                            onClick={() => onToggleReservations(!reservationsEnabled)}
                        >
                            {reservationsEnabled ? "Włączone" : "Wyłączone"}
                        </button>
                    </div>
                    <p className="muted small">
                        Wyłączenie blokuje rezerwacje wszystkich Twoich pomysłów naraz — niezależnie od ustawień
                        poszczególnych grup i pomysłów widocznych dla „Wszystkich znajomych”.
                    </p>
                    <button className="list-row clickable-row" onClick={onManageGroups}>
                        <span>Rezerwacje per grupa</span>
                        <span className="muted small">Zarządzaj w Ludzie →</span>
                    </button>
                </div>
            </div>
            <div className="card body-card">
                <h3>Usunięcie konta</h3>
                <p>Możesz usunąć konto w dowolnym momencie. Wszystkie Twoje dane (pomysły, rezerwacje, grupy) zostaną trwale usunięte.</p>
                {error ? <div className="error-box">{error}</div> : null}
                <button className="secondary-button danger-button" onClick={onDeleteAccount}>Usuń konto</button>
            </div>
        </div>
    );
}
