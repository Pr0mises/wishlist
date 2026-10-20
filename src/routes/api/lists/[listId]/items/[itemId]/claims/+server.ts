import { listItemClaimUpdateSchema } from "$lib/server/validations";
import { ItemEvent } from "$lib/events";
import { requireLoginOrError } from "$lib/server/auth";
import { logger } from "$lib/server/logger";
import z from "zod";
import type { ItemClaimModel, ItemModel } from "$lib/generated/prisma/models";

// Unclaim an item on a list
export const DELETE: RequestHandler = async ({ locals, params }) => {
    const user = locals.user ?? null;
    const claim = user ? await findClaim(params.claimId, user) : await findPublicClaim(params.claimId);

    return deleteClaim(claim);
};

// Update a claim -- set or unset purchased
export const PATCH: RequestHandler = async ({ request, params }) => {
    const user = await requireLoginOrError();
    const $t = await getFormatter();

    const claim = await findClaim(params.claimId, user);
    const updateData = await request.json().then((d) => listItemClaimUpdateSchema.safeParse(d));

    if (updateData.error) {
        error(422, JSON.stringify(z.flattenError(updateData.error).fieldErrors));
    }

    try {
        if (updateData.data?.quantity === 0) {
            return deleteClaim(claim);
        }

        if (
            (updateData.data.purchased !== null && updateData.data.purchased !== undefined) ||
            updateData.data.quantity
        ) {
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

interface ItemClaim extends Pick<ItemClaimModel, "id" | "claimedById" | "publicClaimedById"> {
    item: Pick<ItemModel, "id" | "userId">;
}

async function findPublicClaim(claimId: string): Promise<ItemClaim> {
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

    if (!claim.publicClaimedById) {
        error(403, $t("errors.cannot-update-a-claim-that-is-not-yours"));
    }

    return claim;
}

async function findClaim(claimId: string, user?: LocalUser | null): Promise<ItemClaim> {
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

    if (!user) {
        if (!claim.publicClaimedById) {
            error(403, $t("errors.cannot-update-a-claim-that-is-not-yours"));
        }
        return claim;
    }

    if (claim.claimedById !== user.id && user.id !== claim.item.userId) {
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
