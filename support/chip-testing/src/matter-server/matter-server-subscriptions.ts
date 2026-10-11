/**
 * @license
 * Copyright 2022-2026 Matter.js Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    ClosedError,
    Diagnostic,
    Duration,
    isObject,
    Logger,
    MatterError,
    Seconds,
    TimeoutError,
    UnexpectedDataError,
} from "@matter/general";
import type { MatterServerClient } from "./matter-server-client.js";
import { decodeInteractionReport, type WireInteractionReport } from "./matter-server-wire.js";

const logger = Logger.get("MatterServerSubscriptions");

const DEFAULT_PRIMING_TIMEOUT = Seconds(30);

/** Bounds the teardown of an adapter whose server no longer answers; closing the connection ends it anyway. */
const UNSUBSCRIBE_TIMEOUT = Seconds(5);

/** A subscription the server ended before it sent the subscription's priming report. */
export class MatterServerSubscriptionEndedError extends MatterError {}

/** A subscription opened with `subscribe` on this connection. */
export interface MatterServerSubscription {
    /** The SubscriptionId the device assigned. */
    readonly id: number;

    /** The report that followed the `subscribe` response. */
    readonly priming: WireInteractionReport;

    /**
     * Delivers the reports after the priming report to `onReport`, those that arrived before this call first. Until
     * then they are held, so a caller can judge the priming report before anything reaches its listener.
     */
    listen(onReport: (report: WireInteractionReport) => void): void;

    /** Ends the subscription with `unsubscribe`. Does nothing once the server ended it or it was closed. */
    close(): Promise<void>;
}

interface Tracked {
    description: string;
    priming?: { resolve(report: WireInteractionReport): void; reject(error: Error): void };
    held: WireInteractionReport[];
    onReport?: (report: WireInteractionReport) => void;
}

interface Frame {
    id: number;
    event: string;
    data: unknown;
}

/**
 * The subscriptions one connection opened with `subscribe`, and the `subscription_report` and `subscription_ended`
 * events the server sends the connection for them.
 *
 * The server sends the priming report after the `subscribe` response, so it can arrive before the response is
 * handled; a frame for an id not yet known is held while a `subscribe` is pending. A frame for an id that is not
 * tracked otherwise belongs to a subscription already ended and is dropped, as the API documents.
 */
export class MatterServerSubscriptions {
    readonly #client: MatterServerClient;
    readonly #primingTimeout: Duration;
    readonly #tracked = new Map<number, Tracked>();
    readonly #held = new Array<Frame>();
    readonly #observer = (event: string, data: unknown) => this.#receive(event, data);
    readonly #disconnectObserver = (error: ClosedError) => this.#disconnected(error);
    #opening = 0;
    #closedAll = false;

    constructor(client: MatterServerClient, primingTimeout: Duration = DEFAULT_PRIMING_TIMEOUT) {
        this.#client = client;
        this.#primingTimeout = primingTimeout;
        client.events.on(this.#observer);
        client.disconnected.on(this.#disconnectObserver);
    }

    /**
     * Sends `subscribe` with `args` and resolves once the priming report arrived. Rejects with
     * {@link MatterServerSubscriptionEndedError} when the server ends the subscription first, with {@link ClosedError}
     * when the subscription or the connection is closed first and with {@link TimeoutError} when the priming report
     * does not follow in time; the subscription is ended then.
     */
    async open(args: object, description: string): Promise<MatterServerSubscription> {
        this.#opening++;
        let id: number;
        try {
            id = subscriptionIdOf(await this.#client.command("subscribe", args));
        } catch (error) {
            this.#settleOpening();
            throw error;
        }
        if (this.#closedAll) {
            this.#settleOpening();
            await this.#unsubscribe(id);
            throw new ClosedError(
                `matterjs-server subscriptions were closed while subscription ${id} (${description}) opened`,
            );
        }

        const tracked: Tracked = { description, held: new Array<WireInteractionReport>() };
        const priming = new Promise<WireInteractionReport>(
            (resolve, reject) => (tracked.priming = { resolve, reject }),
        );
        this.#tracked.set(id, tracked);
        this.#settleOpening(id);

        const close = () => this.#close(id);
        let timer: NodeJS.Timeout | undefined;
        try {
            const report = await Promise.race([
                priming,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new TimeoutError(
                                    `matterjs-server sent no priming report for subscription ${id} (${description}) ` +
                                        `within ${Duration.format(this.#primingTimeout)}`,
                                ),
                            ),
                        this.#primingTimeout,
                    );
                }),
            ]);
            return {
                id,
                priming: report,
                listen: onReport => {
                    tracked.onReport = onReport;
                    for (const held of tracked.held.splice(0)) {
                        this.#report(tracked, held);
                    }
                },
                close,
            };
        } catch (error) {
            await close();
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    /** Ends every subscription still open, as the connection is about to close. */
    async closeAll(): Promise<void> {
        this.#closedAll = true;
        await Promise.all([...this.#tracked.keys()].map(id => this.#close(id)));
        this.#client.events.off(this.#observer);
        this.#client.disconnected.off(this.#disconnectObserver);
    }

    async #close(id: number) {
        const tracked = this.#tracked.get(id);
        if (tracked === undefined) {
            return;
        }
        this.#tracked.delete(id);
        tracked.priming?.reject(
            new ClosedError(
                `matterjs-server subscription ${id} (${tracked.description}) was closed before its priming report`,
            ),
        );
        await this.#unsubscribe(id);
    }

    async #unsubscribe(id: number) {
        try {
            await this.#client.command("unsubscribe", { subscription_id: id }, UNSUBSCRIBE_TIMEOUT);
        } catch (error) {
            logger.warn(`Ending matterjs-server subscription ${id} failed:`, error);
        }
    }

    /** The server can no longer report or end anything, so nothing tracked can be ended with `unsubscribe` either. */
    #disconnected(error: ClosedError) {
        for (const { priming } of this.#tracked.values()) {
            priming?.reject(error);
        }
        this.#tracked.clear();
    }

    /** Hands the frames held for `id` to it and drops the rest once no `subscribe` is pending any more. */
    #settleOpening(id?: number) {
        this.#opening--;
        const held = this.#held.splice(0);
        for (const frame of held) {
            if (frame.id === id) {
                this.#receive(frame.event, frame.data);
            } else if (this.#opening > 0) {
                this.#held.push(frame);
            } else {
                dropUntracked(frame.event, frame.id);
            }
        }
    }

    #receive(event: string, data: unknown) {
        if (event !== "subscription_report" && event !== "subscription_ended") {
            return;
        }
        if (!isObject(data) || typeof data.subscription_id !== "number") {
            logger.warn(`matterjs-server sent ${event} without a subscription id: ${Diagnostic.json(data)}`);
            return;
        }
        const id = data.subscription_id;
        const tracked = this.#tracked.get(id);
        if (tracked === undefined) {
            if (this.#opening > 0) {
                this.#held.push({ id, event, data });
            } else {
                dropUntracked(event, id);
            }
            return;
        }

        if (event === "subscription_ended") {
            this.#tracked.delete(id);
            if (tracked.priming !== undefined) {
                tracked.priming.reject(
                    new MatterServerSubscriptionEndedError(
                        `matterjs-server ended subscription ${id} (${tracked.description}) before its priming report`,
                    ),
                );
            } else {
                logger.info(`matterjs-server ended subscription ${id} (${tracked.description})`);
            }
            return;
        }

        let report: WireInteractionReport;
        try {
            report = decodeInteractionReport(data);
        } catch (error) {
            if (tracked.priming !== undefined) {
                tracked.priming.reject(error instanceof Error ? error : new MatterError(String(error)));
            } else {
                logger.warn(`Dropped a report of matterjs-server subscription ${id} (${tracked.description}):`, error);
            }
            return;
        }

        const { priming } = tracked;
        if (priming !== undefined) {
            tracked.priming = undefined;
            priming.resolve(report);
        } else if (tracked.onReport === undefined) {
            tracked.held.push(report);
        } else {
            this.#report(tracked, report);
        }
    }

    #report(tracked: Tracked, report: WireInteractionReport) {
        try {
            tracked.onReport?.(report);
        } catch (error) {
            logger.warn(`Listener of matterjs-server subscription (${tracked.description}) failed:`, error);
        }
    }
}

function dropUntracked(event: string, id: number) {
    logger.debug(`Dropped ${event} for matterjs-server subscription ${id}, which this connection does not track`);
}

function subscriptionIdOf(result: unknown) {
    if (!isObject(result) || typeof result.subscription_id !== "number") {
        throw new UnexpectedDataError(
            `matterjs-server answered subscribe without a subscription id: ${Diagnostic.json(result)}`,
        );
    }
    return result.subscription_id;
}
