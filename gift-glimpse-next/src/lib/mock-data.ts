export type Priority = "bardzo" | "chce" | "moze";

export const priorityMeta: Record<
    Priority,
    { label: string; short: string; emoji: string }
> = {
    bardzo: { label: "Bardzo chcę", short: "Bardzo", emoji: "🔥" },
    chce: { label: "Chcę", short: "Chcę", emoji: "❤️" },
    moze: { label: "Może kiedyś", short: "Kiedyś", emoji: "🤷" },
};

export type IdeaStatus = "active" | "archived";

export type Idea = {
    id: string;
    ownerId: string;
    title: string;
    note: string;
    url?: string;
    price: number | null;
    store: string;
    image: string | null;
    priority: Priority;
    visibility: string[];
    visibleToAll: boolean;
    favorite: boolean;
    addedAt: string;
    status: IdeaStatus;
    archivedAt?: string;
};

export const me = {
    id: "me",
    name: "Julia Chmielewska",
    avatar:
        "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=600&q=80",
    birthday: "12 marca 1994",
    city: "Warszawa",
};

export type Person = {
    id: string;
    name: string;
    avatar: string | null;
    birthday: string;
    birthdayIn: number;
    relation: string;
    groups: string[];
    city?: string;
};
