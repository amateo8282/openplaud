import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { plaudConnections, plaudDevices } from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import type { PlaudDeviceListResponse } from "@/types/plaud";
import { PlaudClient } from "./client";
import { listPlaudWorkspaces, pickPersonalWorkspaceId } from "./workspace";

export interface PersistPlaudConnectionInput {
    userId: string;
    accessToken: string;
    apiBase: string;
    /** Lowercased Plaud account email, or null if unknown. */
    plaudEmail: string | null;
}

export interface PersistPlaudConnectionResult {
    devices: PlaudDeviceListResponse["data_devices"];
    workspaceId: string | null;
}

/**
 * Validate a Plaud user token end-to-end and persist it as the user's
 * connection. Idempotent: re-running with a fresh token replaces the
 * stored one and reconciles devices. Throws on validation failure —
 * callers must not have written anything before invoking this.
 */
export async function persistPlaudConnection({
    userId,
    accessToken,
    apiBase,
    plaudEmail,
}: PersistPlaudConnectionInput): Promise<PersistPlaudConnectionResult> {
    // Workspace discovery is best-effort. If unavailable, the client
    // falls back to the UT directly (see PlaudClient).
    let resolvedWorkspaceId: string | null = null;
    try {
        const list = await listPlaudWorkspaces(accessToken, apiBase);
        resolvedWorkspaceId = pickPersonalWorkspaceId(list);
    } catch (err) {
        console.warn(
            "[plaud/persist] workspace discovery failed:",
            err instanceof Error ? err.message : err,
        );
    }

    // End-to-end validation. Re-throw the underlying AppError verbatim
    // so apiHandler honours its statusCode (wrapping would flatten the
    // auth-vs-upstream distinction).
    const client = new PlaudClient(accessToken, apiBase, resolvedWorkspaceId);
    let deviceList: PlaudDeviceListResponse;
    try {
        deviceList = await client.listDevices();
    } catch (err) {
        console.warn(
            "[plaud/persist] device list validation failed:",
            err instanceof Error ? err.message : err,
        );
        throw err;
    }

    // plaud_connections has no unique constraint on user_id. A per-user
    // transaction-scoped advisory lock serialises concurrent connect
    // attempts so a double-click can't insert duplicate rows; the lock
    // is released automatically on commit/abort.
    const encryptedAccessToken = encrypt(accessToken);

    await db.transaction(async (tx) => {
        await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`plaud_connect:${userId}`}, 0))`,
        );

        const [existingConnection] = await tx
            .select()
            .from(plaudConnections)
            .where(eq(plaudConnections.userId, userId))
            .limit(1);

        if (existingConnection) {
            // Re-scope by userId on UPDATE (defence-in-depth alongside
            // the userId-scoped SELECT above).
            await tx
                .update(plaudConnections)
                .set({
                    bearerToken: encryptedAccessToken,
                    apiBase,
                    plaudEmail,
                    workspaceId: resolvedWorkspaceId,
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        eq(plaudConnections.id, existingConnection.id),
                        eq(plaudConnections.userId, userId),
                    ),
                );
        } else {
            await tx.insert(plaudConnections).values({
                userId,
                bearerToken: encryptedAccessToken,
                apiBase,
                plaudEmail,
                workspaceId: resolvedWorkspaceId,
            });
        }

        // Reconcile devices. Schema enforces unique (userId, serialNumber).
        // Inside the transaction so an aborted connect doesn't leave a
        // half-written device list against the previous token.
        for (const device of deviceList.data_devices) {
            const [existingDevice] = await tx
                .select()
                .from(plaudDevices)
                .where(
                    and(
                        eq(plaudDevices.userId, userId),
                        eq(plaudDevices.serialNumber, device.sn),
                    ),
                )
                .limit(1);

            if (existingDevice) {
                await tx
                    .update(plaudDevices)
                    .set({
                        name: device.name,
                        model: device.model,
                        versionNumber: device.version_number,
                        updatedAt: new Date(),
                    })
                    .where(eq(plaudDevices.id, existingDevice.id));
            } else {
                await tx.insert(plaudDevices).values({
                    userId,
                    serialNumber: device.sn,
                    name: device.name,
                    model: device.model,
                    versionNumber: device.version_number,
                });
            }
        }
    });

    return {
        devices: deviceList.data_devices,
        workspaceId: resolvedWorkspaceId,
    };
}
