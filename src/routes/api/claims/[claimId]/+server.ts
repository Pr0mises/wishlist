import { getFormatter } from "$lib/server/i18n";
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { client } from "$lib/server/prisma";
import { itemEmitter } from "$lib/server/events/emitters";
import { getItemInclusions } from "$lib/server/items";
import { listItemClaimUpdateSchema } from "$lib/server/validations";
import { ItemEvent } from "$lib/events";
import { logger } from "$lib/server/logger";
import z from "zod";
import type { ItemClaimModel, ItemModel } from "$lib/generated/prisma/models";
import { verifyPublicClaimUnclaimToken } from "$lib/server/public-claim-token";

interface ItemClaim extends Pick<ItemClaimModel, "id" | "claimedById" | "publicClaimedById"> {
    item: Pick<ItemModel, "id" | "userId">;
}

// Unclaim an item on a list
export const DELETE: RequestHandler = async ({ locals, params, url }) => {
    const token = url.searchParams.get("token");
    const claim = locals.user
        ? await findClaimForUser(params.claimId, locals.user)
        : await findClaimForPublicToken(params.claimId, token);

    return deleteClaim(claim);
};

// Update a claim -- set or unset purchased
export const PATCH: RequestHandler = async ({ locals, request, params, url }) => {
    const $t = await getFormatter();
    const token = url.searchParams.get("token");

    const claim = locals.user
        ? await findClaimForUser(params.claimId, locals.user)
        : await findClaimForPublicToken(params.claimId, token);

    const updateData = await request.json().then((d) => listItemClaimUpdateSchema.safeParse(d));
    if (updateData.error) {
        error(422, JSON.stringify(z.flattenError(updateData.error).fieldErrors));
    }

    try {
        if (updateData.data?.quantity === 0) {
            return deleteClaim(claim);
        }

        if ((updateData.data.purchased !== null && updateData.data.purchased !== undefined) || updateData.data.quantity) {
            await client.itemClaim.update({
                data: {
                    purchased:
                        updateData.data.purchased !== null && updateData.data.purchased !== undefined
                            ? updateData.data.purchased
                            : undefined,
                    quantity: updateData.data.quantity ?? undefined
                },
                where: {
                    id: claim.id
                }
            });
            const updatedItem = await client.item.findUnique({
                where: {
                    id: claim.item.id
                },
                include: getItemInclusions()
            });
            if (updatedItem) itemEmitter.emit(ItemEvent.ITEM_UPDATE, updatedItem);
        }
        return new Response();
    } catch (err) {
        logger.error({ err }, "Unable to update claim");
        error(500, $t("errors.unable-to-update-claim"));
    }
};

async function findClaimForPublicToken(claimId: string, token: string | null): Promise<ItemClaim> {
    const $t = await getFormatter();
    if (!token) {
        error(401, $t("errors.unauthenticated"));
    }

    const payload = verifyPublicClaimUnclaimToken(token);
    if (!payload || payload.claimId !== claimId) {
        error(403, $t("errors.cannot-update-a-claim-that-is-not-yours"));
    }

    const claim = await client.itemClaim.findUnique({
        select: {
            id: true,
            claimedById: true,
            publicClaimedById: true,
            item: {
                select: {
                    id: true,
                    userId: true
                }
            }
        },
        where: {
            id: claimId
        }
    });

    if (!claim) {
        error(404, $t("errors.claim-was-not-found"));
    }
    if (!claim.publicClaimedById || claim.publicClaimedById !== payload.publicClaimedById) {
        error(403, $t("errors.cannot-update-a-claim-that-is-not-yours"));
    }

    return claim;
}

async function findClaimForUser(claimId: string, user: LocalUser): Promise<ItemClaim> {
    const $t = await getFormatter();

    const claim = await client.itemClaim.findUnique({
        select: {
            id: true,
            claimedById: true,
            publicClaimedById: true,
            item: {
                select: {
                    id: true,
                    userId: true
                }
            }
        },
        where: {
            id: claimId
        }
    });

    if (!claim) {
        error(404, $t("errors.claim-was-not-found"));
    }

    if ((claim.claimedById !== user.id && claim.publicClaimedById !== user.id) && user.id !== claim.item.userId) {
        error(403, $t("errors.cannot-update-a-claim-that-is-not-yours"));
    }

    return claim;
}

async function deleteClaim(claim: ItemClaim) {
    const $t = await getFormatter();

    try {
        await client.itemClaim.delete({
            where: {
                id: claim.id
            }
        });

        const item = await client.item.findUnique({
            where: {
                id: claim.item.id
            },
            include: getItemInclusions()
        });
        if (item) itemEmitter.emit(ItemEvent.ITEM_UPDATE, item);

        return new Response();
    } catch (err) {
        logger.error({ err }, "Unable to unclaim item");
        error(500, $t("errors.unable-to-unclaim-item"));
    }
}
