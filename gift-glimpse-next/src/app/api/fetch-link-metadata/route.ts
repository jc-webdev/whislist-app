import { NextResponse } from "next/server";
import dns from "node:dns/promises";
import net from "node:net";

// ETAP 5 z instrukcja.txt: użytkownik wkleja link, a my próbujemy sami
// wyciągnąć nazwę/zdjęcie/cenę/sklep, żeby nie musiał wpisywać tego ręcznie.
// Fetch musi się dziać po stronie serwera (nie w przeglądarce) z dwóch
// powodów: CORS (większość sklepów nie ustawia access-control-allow-origin
// dla stron produktowych) i bezpieczeństwo — nie chcemy, żeby dowolny kod w
// przeglądarce użytkownika mógł być wektorem do odpytywania cudzych serwerów.
export const runtime = "nodejs";

const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 2 * 1024 * 1024;
const BROWSER_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ponytail: proste sprawdzenie zakresów prywatnych/loopback po rozwiązaniu
// DNS — chroni przed najbardziej oczywistym SSRF (localhost, sieć lokalna,
// metadata endpoint chmury). Nie broni przed DNS rebindingiem (TOCTOU między
// tym sprawdzeniem a właściwym fetchem) — to wymagałoby fetchowania po
// konkretnym, zablokowanym IP zamiast po nazwie hosta. Uznane za
// wystarczające na obecnym etapie (niski profil ryzyka tej funkcji).
function isPrivateIp(ip: string): boolean {
    if (net.isIPv4(ip)) {
        const parts = ip.split(".").map(Number);
        if (parts[0] === 10) return true;
        if (parts[0] === 127) return true;
        if (parts[0] === 0) return true;
        if (parts[0] === 169 && parts[1] === 254) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        return false;
    }
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
}

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

function extractMetaProperty(html: string, property: string): string | null {
    const patterns = [
        new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, "i"),
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, "i"),
    ];
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) return decodeHtmlEntities(match[1]);
    }
    return null;
}

function extractMetaName(html: string, name: string): string | null {
    const patterns = [
        new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, "i"),
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name}["']`, "i"),
    ];
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) return decodeHtmlEntities(match[1]);
    }
    return null;
}

function extractTitleTag(html: string): string | null {
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match ? decodeHtmlEntities(match[1].trim()) : null;
}

function parsePrice(raw: string | null): number | null {
    if (!raw) return null;
    // "1 499,00 zł" -> "1499.00", "$19.99" -> "19.99"
    const cleaned = raw
        .replace(/[^\d,.-]/g, "")
        .replace(/\.(?=\d{3}(?:\D|$))/g, "")
        .replace(",", ".");
    const value = parseFloat(cleaned);
    return Number.isFinite(value) ? value : null;
}

function resolveUrl(maybeRelative: string, base: URL): string {
    try {
        return new URL(maybeRelative, base).toString();
    } catch {
        return maybeRelative;
    }
}

type JsonLdProduct = {
    name?: string;
    description?: string;
    image?: string | string[] | { url?: string } | Array<{ url?: string }>;
    offers?: JsonLdOffer | JsonLdOffer[];
    brand?: string | { name?: string };
};

type JsonLdOffer = { price?: string | number; priceCurrency?: string; seller?: { name?: string } };

function firstImageUrl(image: JsonLdProduct["image"]): string | null {
    if (!image) return null;
    if (typeof image === "string") return image;
    if (Array.isArray(image)) {
        const first = image[0];
        return typeof first === "string" ? first : (first?.url ?? null);
    }
    return image.url ?? null;
}

function firstOffer(offers: JsonLdProduct["offers"]): JsonLdOffer | null {
    if (!offers) return null;
    return Array.isArray(offers) ? (offers[0] ?? null) : offers;
}

// Wiele sklepów (szczególnie polskich) w ogóle nie ustawia OG-owych tagów
// ceny (product:price:amount) — zamiast tego opisują produkt przez JSON-LD
// (schema.org/Product), który jest dziś dużo częstszym standardem SEO niż
// stare rozszerzenia Open Graph. Szukamy pierwszego bloku z @type "Product",
// także zagnieżdżonego w tablicy albo w @graph (typowy wzorzec Yoast/WooCommerce).
function extractJsonLdProduct(html: string): JsonLdProduct | null {
    const scriptPattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = scriptPattern.exec(html))) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(match[1].trim());
        } catch {
            continue;
        }
        const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        for (const candidate of candidates) {
            if (candidate && typeof candidate === "object") {
                const graph = (candidate as { ["@graph"]?: unknown[] })["@graph"];
                if (Array.isArray(graph)) candidates.push(...graph);
            }
        }
        for (const candidate of candidates) {
            if (!candidate || typeof candidate !== "object") continue;
            const type = (candidate as { ["@type"]?: string | string[] })["@type"];
            const isProduct = Array.isArray(type) ? type.includes("Product") : type === "Product";
            if (isProduct) return candidate as JsonLdProduct;
        }
    }
    return null;
}

export async function POST(request: Request) {
    let body: { url?: string };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
    }

    const rawUrl = body.url?.trim();
    if (!rawUrl) {
        return NextResponse.json({ error: "MISSING_URL" }, { status: 400 });
    }

    let target: URL;
    try {
        target = new URL(rawUrl);
    } catch {
        return NextResponse.json({ error: "INVALID_URL" }, { status: 400 });
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
        return NextResponse.json({ error: "UNSUPPORTED_PROTOCOL" }, { status: 400 });
    }
    if (target.hostname === "localhost" || target.hostname === "0.0.0.0") {
        return NextResponse.json({ error: "BLOCKED_HOST" }, { status: 400 });
    }

    try {
        const addresses = await dns.lookup(target.hostname, { all: true });
        if (addresses.some((address) => isPrivateIp(address.address))) {
            return NextResponse.json({ error: "BLOCKED_HOST" }, { status: 400 });
        }
    } catch {
        return NextResponse.json({ error: "DNS_FAILED" }, { status: 200 });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(target.toString(), {
            signal: controller.signal,
            redirect: "follow",
            headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html" },
        });

        if (!response.ok || !response.body) {
            return NextResponse.json({ error: "FETCH_FAILED" }, { status: 200 });
        }

        // Celowo NIE przerywamy już przy pierwszym `</head>` — JSON-LD ze
        // schema.org/Product (patrz niżej) bardzo często siedzi w <body>, nie
        // w <head>. Jedyny limit to MAX_BYTES, więc i tak ograniczone i szybkie.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let html = "";
        let totalBytes = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            html += decoder.decode(value, { stream: true });
            if (totalBytes > MAX_BYTES) break;
        }
        void reader.cancel().catch(() => {});

        const product = extractJsonLdProduct(html);
        const offer = product ? firstOffer(product.offers) : null;

        const title = extractMetaProperty(html, "og:title") ?? extractTitleTag(html) ?? product?.name ?? null;
        const imageRaw =
            extractMetaProperty(html, "og:image") ?? extractMetaName(html, "twitter:image") ?? firstImageUrl(product?.image);
        const description =
            extractMetaProperty(html, "og:description") ?? extractMetaName(html, "description") ?? product?.description ?? null;
        const store =
            extractMetaProperty(html, "og:site_name") ??
            (typeof product?.brand === "string" ? product.brand : product?.brand?.name) ??
            offer?.seller?.name ??
            target.hostname.replace(/^www\./, "");
        const priceRaw =
            extractMetaProperty(html, "product:price:amount") ??
            extractMetaProperty(html, "og:price:amount") ??
            extractMetaName(html, "twitter:data1") ??
            (offer?.price != null ? String(offer.price) : null);

        return NextResponse.json({
            title: title?.trim() || null,
            image: imageRaw ? resolveUrl(imageRaw, target) : null,
            description: description?.trim() || null,
            store: store?.trim() || null,
            price: parsePrice(priceRaw),
        });
    } catch {
        return NextResponse.json({ error: "FETCH_FAILED" }, { status: 200 });
    } finally {
        clearTimeout(timeout);
    }
}
