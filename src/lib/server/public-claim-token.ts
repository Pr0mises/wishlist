import { env } from "$env/dynamic/private";
import { createHmac, timingSafeEqual } from "node:crypto";

const PUBLIC_CLAIM_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const publicClaimSecret = env.PUBLIC_CLAIM_SECRET ?? "development-public-claim-secret";

type PublicClaimTokenPayload = {
    claimId: string;
    publicClaimedById: string;
    exp: number;
};

const encode = (value: string) => Buffer.from(value).toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url").toString("utf8");

export function createPublicClaimUnclaimToken(claimId: string, publicClaimedById: string): string {
    const payload: PublicClaimTokenPayload = {
        claimId,
        publicClaimedById,
        exp: Date.now() + PUBLIC_CLAIM_TOKEN_TTL_MS
    };

    const encoded = encode(JSON.stringify(payload));
    const signature = createHmac("sha256", publicClaimSecret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
}

export function verifyPublicClaimUnclaimToken(token: string): PublicClaimTokenPayload | null {
    if (!token) {
        return null;
    }

    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) {
        return null;
    }

    const expectedSignature = createHmac("sha256", publicClaimSecret).update(encoded).digest("base64url");
    const expected = Buffer.from(expectedSignature);
    const actual = Buffer.from(signature);

    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return null;
    }

    try {
        const payload = JSON.parse(decode(encoded)) as PublicClaimTokenPayload;
        if (!payload.claimId || !payload.publicClaimedById || Number.isNaN(payload.exp)) {
            return null;
        }
        if (payload.exp < Date.now()) {
            return null;
        }
        return payload;
    } catch {
        return null;
    }
}
