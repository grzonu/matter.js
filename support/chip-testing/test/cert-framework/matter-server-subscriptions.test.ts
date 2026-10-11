/**
 * @license
 * Copyright 2022-2026 Matter.js Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    ClosedError,
    Diagnostic,
    LogDestination,
    Logger,
    LogLevel,
    Millis,
    Seconds,
    TimeoutError,
    UnexpectedDataError,
} from "@matter/general";
import { expect } from "chai";
import { MatterServerClient } from "../../src/matter-server/matter-server-client.js";
import { MatterServerSubscriptions } from "../../src/matter-server/matter-server-subscriptions.js";
import type { WireInteractionReport } from "../../src/matter-server/matter-server-wire.js";
import { waitFor } from "./fake-chip-tool.js";
import { FakeMatterServer, type FakeServerRequest } from "./fake-matter-server.js";

async function rejectionOf(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (e) {
        return e;
    }
    expect.fail("expected a rejection");
}

/** Timers alive in this process; a timer left behind keeps the test runner from exiting. */
function activeTimers() {
    return process.getActiveResourcesInfo().filter(resource => resource === "Timeout").length;
}

async function warningsDuring(action: () => Promise<void>) {
    const warnings = new Array<string>();
    Logger.destinations.capture = LogDestination({
        add(message: Diagnostic.Message) {
            if (message.level >= LogLevel.WARN) {
                warnings.push(String(message.values[0]));
            }
        },
    });
    try {
        await action();
    } finally {
        delete Logger.destinations.capture;
    }
    return warnings;
}

function onOff(report: WireInteractionReport) {
    const entry = report.attributes.get("1/6/0");
    return entry?.kind === "value" ? entry.value : undefined;
}

describe("MatterServerSubscriptions", () => {
    let server: FakeMatterServer;
    let client: MatterServerClient;
    let subscriptions: MatterServerSubscriptions;
    let pending: FakeServerRequest[];

    beforeEach(async () => {
        server = await FakeMatterServer.start();
        pending = [];
        server.reply = request => {
            if (request.command === "unsubscribe" || request.command === "barrier") {
                return { result: null };
            }
            pending.push(request);
            return undefined;
        };
        client = await MatterServerClient.connect(server.url);
        subscriptions = new MatterServerSubscriptions(client, Millis(200));
    });

    afterEach(async () => {
        await subscriptions.closeAll();
        await client.close();
        await server.close();
        expect(server.failures).deep.equals([]);
    });

    /** The socket keeps frame order, so once the answer arrives every frame the server sent before it was handled. */
    async function barrier() {
        await client.command("barrier");
    }

    function report(id: number, onOffValue: boolean) {
        server.pushEvent("subscription_report", {
            subscription_id: id,
            attributes: { "1/6/0": onOffValue },
            events: [],
        });
    }

    async function subscribeRequest(count = 1) {
        await waitFor(() => pending.length >= count, `${count} subscribe request(s)`);
        return pending[count - 1];
    }

    const unsubscribed = () =>
        server.requests.filter(({ command }) => command === "unsubscribe").map(({ args }) => args);

    it("takes a priming report that arrives before the subscribe response as the priming report", async () => {
        const opening = subscriptions.open({ node_id: 5 }, "test");
        const request = await subscribeRequest();

        report(7, true);
        server.respond(request.messageId, { result: { subscription_id: 7 } });

        const subscription = await opening;
        expect(subscription.id).equals(7);
        expect(onOff(subscription.priming)).equals(true);
    });

    it("drops a report for a subscription it does not track while no subscribe is pending", async () => {
        report(7, false);
        await barrier();

        const opening = subscriptions.open({ node_id: 5 }, "test");
        const request = await subscribeRequest();
        server.respond(request.messageId, { result: { subscription_id: 7 } });
        report(7, true);

        expect(onOff((await opening).priming)).equals(true);
    });

    it("keeps the frames of a subscribe still pending while another one settles", async () => {
        const first = subscriptions.open({ node_id: 5 }, "first");
        const second = subscriptions.open({ node_id: 6 }, "second");
        const [firstRequest, secondRequest] = [await subscribeRequest(1), await subscribeRequest(2)];

        report(2, false);
        server.respond(firstRequest.messageId, { result: { subscription_id: 1 } });
        report(1, true);
        await first;
        server.respond(secondRequest.messageId, { result: { subscription_id: 2 } });

        expect(onOff((await first).priming)).equals(true);
        expect(onOff((await second).priming)).equals(false);
    });

    it("holds the reports after the priming report until a listener is attached", async () => {
        const opening = subscriptions.open({ node_id: 5 }, "test");
        const request = await subscribeRequest();
        server.respond(request.messageId, { result: { subscription_id: 7 } });
        report(7, true);
        report(7, false);
        report(7, true);
        const subscription = await opening;
        await barrier();

        const seen = new Array<unknown>();
        subscription.listen(next => seen.push(onOff(next)));
        expect(seen).deep.equals([false, true]);

        report(7, false);
        await waitFor(() => seen.length === 3, "a third report");
        expect(seen).deep.equals([false, true, false]);
    });

    it("fails and ends a subscription whose priming report does not follow in time", async () => {
        const opening = subscriptions.open({ node_id: 5 }, "test");
        const request = await subscribeRequest();
        server.respond(request.messageId, { result: { subscription_id: 7 } });

        expect(await rejectionOf(opening)).instanceOf(TimeoutError);
        expect(unsubscribed()).deep.equals([{ subscription_id: 7 }]);
    });

    it("fails and ends a subscription whose priming report does not have the documented shape", async () => {
        const opening = subscriptions.open({ node_id: 5 }, "test");
        const request = await subscribeRequest();
        server.respond(request.messageId, { result: { subscription_id: 7 } });
        server.pushEvent("subscription_report", { subscription_id: 7, attributes: {} });

        expect(await rejectionOf(opening)).instanceOf(UnexpectedDataError);
        expect(unsubscribed()).deep.equals([{ subscription_id: 7 }]);
    });

    it("fails a subscribe answered without a subscription id", async () => {
        const opening = subscriptions.open({ node_id: 5 }, "test");
        const request = await subscribeRequest();
        server.respond(request.messageId, { result: {} });

        expect(await rejectionOf(opening)).instanceOf(UnexpectedDataError);
    });

    it("drops reports for unknown ids again once a failed subscribe is no longer pending", async () => {
        const failed = subscriptions.open({ node_id: 5 }, "failed");
        server.respond((await subscribeRequest(1)).messageId, { result: {} });
        await rejectionOf(failed);

        report(7, false);
        await barrier();
        const opening = subscriptions.open({ node_id: 5 }, "test");
        server.respond((await subscribeRequest(2)).messageId, { result: { subscription_id: 7 } });
        report(7, true);

        expect(onOff((await opening).priming)).equals(true);
    });

    it("fails a pending priming report at once when the connection drops", async () => {
        const patient = new MatterServerSubscriptions(client, Seconds(30));
        try {
            const opening = patient.open({ node_id: 5 }, "test");
            server.respond((await subscribeRequest()).messageId, { result: { subscription_id: 7 } });
            await waitFor(() => server.connections === 1, "connection");
            server.dropClients();

            expect(await rejectionOf(opening)).instanceOf(ClosedError);
            expect(unsubscribed()).deep.equals([]);
        } finally {
            await patient.closeAll();
        }
    });

    it("fails a pending priming report at once when the subscriptions close", async () => {
        const patient = new MatterServerSubscriptions(client, Seconds(30));
        const outcome = rejectionOf(patient.open({ node_id: 5 }, "test"));
        server.respond((await subscribeRequest()).messageId, { result: { subscription_id: 7 } });
        await barrier();

        const timers = activeTimers();
        await patient.closeAll();

        expect(await outcome).instanceOf(ClosedError);
        expect(unsubscribed()).deep.equals([{ subscription_id: 7 }]);
        expect(activeTimers()).lessThan(timers);
    });

    it("refuses and ends a subscription the server answers after the subscriptions closed", async () => {
        const outcome = rejectionOf(subscriptions.open({ node_id: 5 }, "test"));
        const request = await subscribeRequest();
        await subscriptions.closeAll();
        server.respond(request.messageId, { result: { subscription_id: 7 } });

        expect(await outcome).instanceOf(ClosedError);
        expect(unsubscribed()).deep.equals([{ subscription_id: 7 }]);
    });

    it("leaves no priming timer behind once the priming report arrived", async () => {
        const patient = new MatterServerSubscriptions(client, Seconds(30));
        try {
            const open = async (id: number, count: number) => {
                const opening = patient.open({ node_id: 5 }, "test");
                server.respond((await subscribeRequest(count)).messageId, { result: { subscription_id: id } });
                report(id, true);
                await opening;
            };
            // Mocha arms its own test timer once the test awaits, so the count starts after the first subscription
            await open(7, 1);
            const timers = activeTimers();
            await open(8, 2);

            expect(activeTimers()).equals(timers);
        } finally {
            await patient.closeAll();
        }
    });

    it("drops a later report that does not have the documented shape and keeps delivering", async () => {
        const opening = subscriptions.open({ node_id: 5 }, "test");
        server.respond((await subscribeRequest()).messageId, { result: { subscription_id: 7 } });
        report(7, true);
        const subscription = await opening;
        const seen = new Array<unknown>();
        subscription.listen(next => seen.push(onOff(next)));

        const warnings = await warningsDuring(async () => {
            server.pushEvent("subscription_report", { subscription_id: 7, attributes: {} });
            report(7, false);
            await waitFor(() => seen.length === 1, "one report");
        });

        expect(seen).deep.equals([false]);
        expect(
            warnings.some(warning => warning.startsWith("Dropped a report of matterjs-server subscription 7")),
        ).equals(true);
    });

    it("keeps delivering the held reports after a listener throws", async () => {
        const opening = subscriptions.open({ node_id: 5 }, "test");
        server.respond((await subscribeRequest()).messageId, { result: { subscription_id: 7 } });
        report(7, true);
        report(7, false);
        report(7, true);
        const subscription = await opening;
        await barrier();

        const seen = new Array<unknown>();
        subscription.listen(next => {
            seen.push(onOff(next));
            if (seen.length === 1) {
                throw new UnexpectedDataError("listener failure");
            }
        });

        expect(seen).deep.equals([false, true]);
    });

    it("ignores a subscription event without a subscription id", async () => {
        const opening = subscriptions.open({ node_id: 5 }, "test");
        const request = await subscribeRequest();
        server.pushEvent("subscription_report", { attributes: {}, events: [] });
        server.respond(request.messageId, { result: { subscription_id: 7 } });
        report(7, true);

        expect(onOff((await opening).priming)).equals(true);
    });

    it("ends a subscription once, however often it is closed", async () => {
        const opening = subscriptions.open({ node_id: 5 }, "test");
        const request = await subscribeRequest();
        server.respond(request.messageId, { result: { subscription_id: 7 } });
        report(7, true);
        const subscription = await opening;

        await subscription.close();
        await subscription.close();
        await subscriptions.closeAll();
        expect(unsubscribed()).deep.equals([{ subscription_id: 7 }]);
    });
});
