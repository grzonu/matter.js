/**
 * @license
 * Copyright 2022-2026 Matter.js Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Duration } from "@matter/general";
import {
    ClosedError,
    Diagnostic,
    ImplementationError,
    InternalError,
    isObject,
    Logger,
    MatterError,
    Minutes,
    Mutex,
    UnexpectedDataError,
} from "@matter/general";
import { getOperationalDeviceQname } from "@matter/main/protocol";
import { GlobalFabricId, ManualPairingCodeCodec, NodeId, Status, StatusResponseError } from "@matter/main/types";
import { Matter } from "@matter/model";
import type {
    AttributePathSpec,
    AttributeReadEntry,
    CertGroupApi,
    CertNodeApi,
    CertNodeRef,
    ClientAttributePath,
    ClientEndpointEntry,
    CommissioningTarget,
    ControllerAdapter,
    ControllerAdapterOptions,
    ControllerCapability,
    ControllerCapabilityGaps,
    EventPathSpec,
    EventReadEntry,
    ManualPairingCodeFields,
    OnboardingPayloadFields,
    PicsValues,
    ReadAttributeOptions,
    ReadEventOptions,
    SubscribeEventOptions,
    SubscribeOptions,
    TimedInteractionOptions,
} from "@matter/testing";
import { capabilitiesFor, CertConfigError, LogFollower, UnsupportedByControllerError } from "@matter/testing";
import { env } from "node:process";
import type { MatterServerClient } from "../matter-server/matter-server-client.js";
import { MatterServerProcess } from "../matter-server/matter-server-process.js";
import { MatterServerSubscriptions } from "../matter-server/matter-server-subscriptions.js";
import {
    decodeAttributeResult,
    decodeCommandResponse,
    decodeInteractionReport,
    encodeAttributeValue,
    encodeCommandPayload,
    MatterServerUnmodeledError,
    type WireEvent,
    type WirePathStatus,
    type WireValueResult,
} from "../matter-server/matter-server-wire.js";
import { findCertCluster } from "./custom-clusters.js";
import { refusalOf, singleQrPayload } from "./onboarding-payload.js";
import { timedInteractionTimeoutOf } from "./timed-interaction.js";

const logger = Logger.get("MatterServerControllerAdapter");

/** Name {@link UnsupportedByControllerError} reports for this adapter. */
const CONTROLLER = "matterjs-server";

/**
 * Outlasts matter.js's own commissioning budget, which waits out the specification's 3-minute minimum commissioning
 * window for a device that never answers: a WS timeout before that would report a failure while the server still
 * commissions.
 */
const COMMISSION_TIMEOUT = Minutes(5);

/** Concrete ids `splitAttributePath` on the server reads as wildcards, for an event id as for an attribute id. */
const WILDCARD_ENDPOINT = 0xffff;
const WILDCARD_CLUSTER = 0xffffffff;
const WILDCARD_LEAF = 0xffffffff;

const DESCRIPTOR = 0x1d;
const DEVICE_TYPE_LIST = 0;
const PARTS_LIST = 3;

/**
 * What this controller claims about itself, overlaying the device's PICS for a run (see `controllerPicsOverridesFor`).
 * Only what differs from the CHIP PICS file, which describes a device.
 */
export const MATTERJS_SERVER_CONTROLLER_PICS: PicsValues = {
    // `device_command` sends one command per invoke request and no CommandRef.
    "MCORE.IDM.C.InvokeRequest.BatchCommands": 0,

    "MCORE.ROLE.COMMISSIONER": 1,

    // `commission_with_code` takes either onboarding payload, the scanned `MT:…` form included.
    "MCORE.DD.QR_COMMISSIONING": 1,
    "MCORE.DD.MANUAL_PC_COMMISSIONING": 1,
    "MCORE.DD.SCAN_QR_CODE": 1,

    // A concatenated payload names several commissionees and is refused; the caller is told to split it.
    "MCORE.DD.CTRL_CONCATENATED_QR_CODE_1": 0,

    // `open_commissioning_window` ignores its `option` and always opens an enhanced window.
    "CADMIN.C.C01.Tx": 0,

    // The server hosts matter.js's OTA provider, so it takes the BDX and OTA roles the in-process controller declares.
    // The CHIP PICS file answers these for a device. What this adapter cannot drive of the provider is the
    // `ota-provider` capability gap.
    "MCORE.BDX.Sender": 1,
    "MCORE.BDX.Responder": 1,
    "MCORE.BDX.SynchronousSender": 1,
    "MCORE.BDX.AsynchronousSender": 0,
    "MCORE.BDX.BlockQueryWithSkip": 0,
    "MCORE.OTA.Provider": 1,
    "MCORE.OTA.HTTPS": 0,
    "OTAR.C.M.AnnounceOTAProvider": 1,
    "OTAR.C.M.NotifyUpdateApplied": 0,
    "OTAP.S.M.DelayedActionTime": 1,
    "OTAP.S.M.UserConsentNeeded": 1,

    // The server registers as an ICD Check-In client (`register_icd`). The CHIP PICS file answers only the server
    // side. That this adapter does not expose the client is the `icd-client` capability gap.
    "ICDB.C": 1,

    // The server is a bridge client that maintains the devices behind a bridge. The CHIP PICS file answers these for
    // a device. That it maintains them only through a subscription of its own, which it runs without here, is the
    // `sustained-subscription` capability gap.
    "MCORE.BRIDGECLIENT": 1,
    "MCORE.DEVLIST.UseDevices": 1,
    "MCORE.DEVLIST.UseDeviceName": 1,
    "MCORE.DEVLIST.UseDeviceState": 1,
    "MCORE.DEVLIST.UseBatInfo": 1,

    // Client commands `device_command` sends for the cases that need them. The CHIP PICS file answers 0 for these
    // because it describes a device; here the client is the controller.
    "ACT.C.C00.Tx": 1,
    "ACT.C.C01.Tx": 1,
    "ACT.C.C02.Tx": 1,
    "ACT.C.C03.Tx": 1,
    "ACT.C.C04.Tx": 1,
    "ACT.C.C05.Tx": 1,
    "ACT.C.C06.Tx": 1,
    "ACT.C.C07.Tx": 1,
    "ACT.C.C08.Tx": 1,
    "ACT.C.C09.Tx": 1,
    "ACT.C.C0a.Tx": 1,
    "ACT.C.C0b.Tx": 1,
    "G.C.C00.Tx": 1,
    "G.C.C01.Tx": 1,
    "G.C.C02.Tx": 1,
    "G.C.C03.Tx": 1,
    "G.C.C04.Tx": 1,
    "G.C.C05.Tx": 1,
    "GRPKEY.C.C03.Tx": 1,
    "GRPKEY.C.C04.Tx": 1,
    "S.C": 1,
    "S.C.C00.Tx": 1,
    "S.C.C01.Tx": 1,
    "S.C.C02.Tx": 1,
    "S.C.C03.Tx": 1,
    "S.C.C04.Tx": 1,
    "S.C.C05.Tx": 1,
    "S.C.C06.Tx": 1,
    "S.C.C40.Tx": 1,
    "TBRM.C": 1,
    "TBRM.C.C00.Tx": 1,
    "TBRM.C.C01.Tx": 1,
    "TBRM.C.C03.Tx": 1,
    "TBRM.C.C04.Tx": 1,
};

/**
 * What this controller lacks, declared with its registration so a step needing one of these is skipped before it acts
 * (see `controllerCapabilityGap`). The adapter refuses each operation that needs one of them as well, before it sends
 * anything, except `clientEndpoints` and `clientAttribute`, which answer what the server holds.
 */
export const MATTERJS_SERVER_CAPABILITY_GAPS = {
    "single-handshake-attempt":
        "the WebSocket API has no option for it, and the server's own retries would answer the refusal the step " +
        "means to prove",
    "commissioning-give-up":
        "the WebSocket API has no commissioning timeout, so the server's own policy would decide when it stops looking",
    "group-messaging": "the WebSocket API has no group key management and no group addressing",
    "tcp-transport": "the server chooses the transport of each session itself and the WebSocket API cannot ask for one",
    "data-versions": "the read and subscribe results carry no cluster data versions",
    "unmodeled-data":
        "the server addresses only clusters and attributes of its own Matter model, and sends values outside it " +
        "lossily",
    attestation: "the server reads revocation from the DCL and the WebSocket API cannot install a revocation set",
    "webrtc-requestor": "the WebSocket API does not expose the server's requestor cluster to a case",
    "ota-provider":
        "the WebSocket API cannot stage an image with the server's OTA provider, report what it answered or script " +
        "its answers",
    "icd-client": "this adapter does not expose the server's ICD client",
    "sustained-subscription":
        "the server runs with --disable-auto-subscription so a case's own subscriptions are possible, so it holds no " +
        "subscription of its own to observe events through or to keep its device list current",
} as const satisfies ControllerCapabilityGaps;

function refusal(capability: ControllerCapability, operation: string) {
    return new UnsupportedByControllerError(operation, CONTROLLER, MATTERJS_SERVER_CAPABILITY_GAPS[capability]);
}

/**
 * A read or a subscription's priming report the server answered with neither a value nor a status for a concrete path
 * the step asked for.
 */
export class MatterServerReadError extends MatterError {}

/** What {@link MatterServerControllerAdapter} needs of a running server. {@link MatterServerProcess} is one. */
export interface MatterServerConnection {
    readonly client: MatterServerClient;

    /** The entry point the server was started from. */
    readonly entry: string;

    /** The server's own output, which is what the adapter reports as its log. */
    readonly log: LogFollower;

    close(): Promise<void>;
}

/**
 * Starts the server an adapter drives. `signal` aborts when the adapter closes before the server is ready. The
 * launcher must honour it and reject once it stopped what it started: `close()` waits for the launch to settle, so
 * a launcher that ignores the signal blocks `close()` until the server is ready.
 */
export type MatterServerLauncher = (role: string, signal: AbortSignal) => Promise<MatterServerConnection>;

/**
 * Starts matterjs-server from `MATTER_CERT_SERVER_ENTRY`, on the interface `MATTER_MDNS_NETWORKINTERFACE` names
 * where it is set.
 */
async function launchFromEnvironment(role: string, signal: AbortSignal): Promise<MatterServerConnection> {
    const entry = env.MATTER_CERT_SERVER_ENTRY;
    if (entry === undefined || entry === "") {
        throw new CertConfigError(
            'MATTER_CERT_CONTROLLER="matterjs-server" needs MATTER_CERT_SERVER_ENTRY, the server entry point to run',
        );
    }
    return MatterServerProcess.start({
        entry,
        role,
        primaryInterface: env.MATTER_MDNS_NETWORKINTERFACE || undefined,
        signal,
    });
}

/**
 * Drives matterjs-server as the DUT controller, through its WebSocket API.
 *
 * Operations the WebSocket API cannot express throw {@link UnsupportedByControllerError} before they send anything.
 * Those with a PICS key are declared in {@link MATTERJS_SERVER_CONTROLLER_PICS}, and those a step states as a
 * controller capability in {@link MATTERJS_SERVER_CAPABILITY_GAPS}, so their steps are skipped before they run.
 *
 * The server runs with `--disable-auto-subscription`, so reads and subscriptions are the adapter's own: `read`,
 * `subscribe` and `unsubscribe`. A `read` goes out as the in-process adapter sends it. To a `subscribe` the server adds
 * the data versions it holds, so a priming report can leave out a cluster that did not change; a concrete path it
 * leaves out fails with {@link MatterServerReadError}. The node's state the server holds changes only with what those
 * report.
 *
 * Statuses:
 *
 * - A status a device answers a concrete read or subscribe path with surfaces as `StatusResponseError` with its
 *   cluster status, as in-process.
 * - A status the device answers an invoke with surfaces as `MatterServerCommandError` with a message only.
 * - A write's status code from the device surfaces as `StatusResponseError` without a cluster status. A write the
 *   server itself refuses surfaces as `MatterServerCommandError`.
 *
 * A step that asserts an invoke's status therefore fails rather than passing on the wrong one.
 *
 * The server merges concurrent identical invokes into one request to the device, so the adapter sends the invokes of
 * one node one at a time, in call order.
 */
export class MatterServerControllerAdapter implements ControllerAdapter {
    readonly id: string;

    readonly #launch: MatterServerLauncher;
    readonly #invokeQueues = new Map<string, Mutex>();
    readonly #closing = new AbortController();
    #starting?: Promise<void>;
    #connection?: MatterServerConnection;
    #subscriptions?: MatterServerSubscriptions;

    constructor(id: string, options?: ControllerAdapterOptions, launch: MatterServerLauncher = launchFromEnvironment) {
        const [lacking] = capabilitiesFor(options);
        if (lacking !== undefined) {
            throw refusal(lacking, `an adapter built for ${lacking}`);
        }

        this.id = id;
        this.#launch = launch;
    }

    get log(): LogFollower {
        return this.#started.log;
    }

    get build(): Record<string, string> | undefined {
        if (this.#connection === undefined) {
            return undefined;
        }
        const { entry, client } = this.#connection;
        return {
            entry,
            sdkVersion: client.serverInfo.sdk_version,
            schemaVersion: String(client.serverInfo.schema_version),
        };
    }

    async start(): Promise<void> {
        if (this.#closing.signal.aborted) {
            throw new ImplementationError(`Controller adapter "${this.id}" was closed and cannot be restarted`);
        }
        if (this.#starting !== undefined) {
            throw new ImplementationError(`Controller adapter "${this.id}": start() was already called`);
        }
        this.#starting = this.#connect();
        await this.#starting;
    }

    async #connect() {
        const connection = await this.#launch(this.id, this.#closing.signal);
        if (this.#closing.signal.aborted) {
            await connection.close();
            throw new ClosedError(`Controller adapter "${this.id}" was closed while its server started`);
        }
        this.#connection = connection;
        this.#subscriptions = new MatterServerSubscriptions(connection.client);
    }

    /** Also stops a server still starting, before it resolves. */
    async close(): Promise<void> {
        this.#closing.abort();
        // start() reports its own failure to its caller
        await Promise.allSettled([this.#starting]);
        const connection = this.#connection;
        const subscriptions = this.#subscriptions;
        this.#connection = undefined;
        this.#subscriptions = undefined;
        try {
            await subscriptions?.closeAll();
        } finally {
            await connection?.close();
        }
    }

    get #started() {
        if (this.#connection === undefined) {
            throw new ImplementationError(`Controller adapter "${this.id}" was used before start()`);
        }
        return this.#connection;
    }

    get #startedSubscriptions() {
        if (this.#subscriptions === undefined) {
            throw new ImplementationError(`Controller adapter "${this.id}" was used before start()`);
        }
        return this.#subscriptions;
    }

    async commission(target: CommissioningTarget): Promise<CertNodeRef> {
        if (target.singleHandshakeAttempt) {
            throw refusal(
                "single-handshake-attempt",
                "commissioning bounded to a single operational handshake attempt",
            );
        }
        if (target.giveUpAfterMs !== undefined) {
            throw refusal("commissioning-give-up", "commissioning bounded to a discovery budget");
        }

        // The server decodes a code with the same matter.js codec, so a code it would refuse is refused here, before
        // the request, as the in-process adapter refuses it: the WebSocket API reports the server's refusal only as a
        // message.
        let command: string;
        let args: object;
        if (target.qrPairingCode) {
            singleQrPayload(target.qrPairingCode);
            command = "commission_with_code";
            args = { code: target.qrPairingCode, network_only: true };
        } else if (target.manualPairingCode !== undefined) {
            decodeManualPairingCode(target.manualPairingCode);
            command = "commission_with_code";
            args = { code: target.manualPairingCode, network_only: true };
        } else if (target.passcode !== undefined && target.discriminator !== undefined) {
            command = "commission_on_network";
            args = { setup_pin_code: target.passcode, filter_type: 2, filter: target.discriminator };
        } else {
            throw new ImplementationError(
                "commission() requires a target.qrPairingCode, a target.manualPairingCode, or both target.passcode " +
                    "and target.discriminator",
            );
        }

        const node = await this.#started.client.command(command, args, COMMISSION_TIMEOUT);
        if (!isObject(node) || (typeof node.node_id !== "number" && typeof node.node_id !== "bigint")) {
            throw new UnexpectedDataError(
                `matterjs-server answered ${command} without a node id: ${Diagnostic.json(node)}`,
            );
        }
        return node.node_id.toString();
    }

    /**
     * The WebSocket API reports no parse, so this reads the payload with the matter.js codec the server's
     * `commission_with_code` reads it with.
     */
    async parseQrPayload(code: string): Promise<OnboardingPayloadFields> {
        const { version, vendorId, productId, flowType, discoveryCapabilities, discriminator, passcode } =
            singleQrPayload(code);
        return { version, vendorId, productId, flowType, discoveryCapabilities, discriminator, passcode };
    }

    /** As {@link parseQrPayload}, with the codec `commission_with_code` reads a manual pairing code with. */
    async parseManualPairingCode(code: string): Promise<ManualPairingCodeFields> {
        const { shortDiscriminator, passcode, vendorId, productId } = decodeManualPairingCode(code);
        if (shortDiscriminator === undefined) {
            throw new InternalError(`Manual pairing code ${code} decoded to no short discriminator`);
        }
        return { shortDiscriminator, passcode, vendorId, productId };
    }

    node(ref: CertNodeRef): CertNodeApi {
        const key = NodeId(BigInt(ref)).toString();
        let queue = this.#invokeQueues.get(key);
        if (queue === undefined) {
            queue = new Mutex(`matterjs-server invokes of node ${key}`);
            this.#invokeQueues.set(key, queue);
        }
        return new MatterServerCertNodeApi(
            () => this.#started.client,
            () => this.#startedSubscriptions,
            ref,
            queue,
        );
    }

    group(_groupId: number): CertGroupApi {
        return new MatterServerCertGroupApi();
    }
}

class MatterServerCertGroupApi implements CertGroupApi {
    async defineKeySet(): Promise<void> {
        throw refusal("group-messaging", "installing a group key set");
    }

    async invoke(): Promise<void> {
        throw refusal("group-messaging", "invoking a group command");
    }
}

class MatterServerCertNodeApi implements CertNodeApi {
    readonly #client: () => MatterServerClient;
    readonly #subscriptions: () => MatterServerSubscriptions;
    readonly #nodeId: NodeId;
    readonly #invokeQueue: Mutex;

    constructor(
        client: () => MatterServerClient,
        subscriptions: () => MatterServerSubscriptions,
        ref: CertNodeRef,
        invokeQueue: Mutex,
    ) {
        this.#client = client;
        this.#subscriptions = subscriptions;
        this.#invokeQueue = invokeQueue;
        this.#nodeId = NodeId(BigInt(ref));
    }

    #command(command: string, args: object, timeout?: Duration) {
        return this.#client().command(command, args, timeout);
    }

    async invoke(
        cluster: string | number,
        command: string,
        args?: object,
        endpoint = 0,
        options?: TimedInteractionOptions,
    ): Promise<unknown> {
        const clusterModel = Matter.clusters(cluster);
        if (clusterModel === undefined) {
            if (findCertCluster(cluster) !== undefined) {
                throw refusal("unmodeled-data", `invoke ${cluster}.${command}`);
            }
            throw new ImplementationError(`Unknown cluster ${cluster}`);
        }
        const commandModel = clusterModel.commands(command);
        if (clusterModel.id === undefined || commandModel === undefined) {
            throw new ImplementationError(`Unknown command "${command}" on cluster ${clusterModel.name}`);
        }

        const timeout = timedInteractionTimeoutOf(options);
        if (timeout === 0) {
            throw new UnsupportedByControllerError(
                `invoke ${clusterModel.name}.${commandModel.name} timed with a zero timeout`,
                CONTROLLER,
                "the server makes an invoke timed only for a non-zero timeout, so it would send this one untimed",
            );
        }

        const request = {
            node_id: this.#nodeId,
            endpoint_id: endpoint,
            cluster_id: clusterModel.id,
            command_name: commandModel.name,
            payload: encodeCommandPayload(clusterModel.id, commandModel.name, args ?? {}),
            ...(timeout === undefined ? {} : { timed_request_timeout_ms: timeout }),
        };
        const result = await this.#invokeQueue.produce(() => this.#command("device_command", request));
        return decodeCommandResponse(clusterModel.id, commandModel.name, result);
    }

    async invokeBatch(): Promise<never> {
        throw new UnsupportedByControllerError(
            "invokeBatch",
            CONTROLLER,
            "device_command sends one command per invoke request and no CommandRef",
        );
    }

    async readAttribute(path: AttributePathSpec, options?: ReadAttributeOptions): Promise<unknown> {
        const report = await this.#readAttributes([path], options);
        const key = concreteKeyOf(path);
        if (key === undefined) {
            return entriesOf(report.attributes);
        }
        throwIfRefused(report.attributeStatus, key, "readAttribute");
        const entry = report.attributes.get(key);
        if (entry === undefined) {
            throw new MatterServerReadError(`matterjs-server returned neither a value nor a status for ${key}`);
        }
        return valueOf(entry, key);
    }

    async readAttributes(paths: AttributePathSpec[], options?: ReadAttributeOptions): Promise<AttributeReadEntry[]> {
        if (paths.length === 0) {
            throw new ImplementationError("readAttributes requires at least one path");
        }
        const report = await this.#readAttributes(paths, options);
        throwIfAnyRefused(report.attributeStatus, paths.map(concreteKeyOf), "readAttributes");
        return entriesOf(report.attributes);
    }

    async writeAttribute(path: AttributePathSpec, value: unknown, options?: TimedInteractionOptions): Promise<void> {
        const { endpoint, cluster, attribute } = path;
        if (endpoint === undefined || cluster === undefined || attribute === undefined) {
            throw new ImplementationError("writeAttribute requires a concrete endpoint/cluster/attribute path");
        }
        if (timedInteractionTimeoutOf(options) !== undefined) {
            throw new UnsupportedByControllerError(
                "a timed write",
                CONTROLLER,
                "write_attribute has no timed-request timeout",
            );
        }
        assertExpressible(path);
        if (Matter.clusters(cluster)?.attributes(attribute) === undefined) {
            throw refusal("unmodeled-data", `writing attribute ${attribute} of cluster ${cluster}`);
        }

        const result = await this.#command("write_attribute", {
            node_id: this.#nodeId,
            attribute_path: pathKeyOf(path),
            value: encodeAttributeValue(cluster, attribute, value),
        });
        const status = writeStatusOf(result);
        if (status !== Status.Success) {
            throw StatusResponseError.create(status);
        }
    }

    async writeAttributes(): Promise<never> {
        throw new UnsupportedByControllerError(
            "writeAttributes",
            CONTROLLER,
            "write_attribute writes one attribute per request, by a concrete path and without a data version",
        );
    }

    /**
     * Keeps other subscriptions to the node, as the in-process adapter does: the server's default would end every
     * other subscription of the controller to it.
     */
    async subscribe(path: AttributePathSpec, opts: SubscribeOptions): Promise<unknown> {
        assertExpressible(path);
        const key = pathKeyOf(path);
        const subscription = await this.#subscriptions().open(
            {
                node_id: this.#nodeId,
                attribute_paths: [key],
                fabric_filtered: true,
                min_interval: opts.minIntervalFloorSeconds,
                max_interval: opts.maxIntervalCeilingSeconds,
                keep_subscriptions: true,
            },
            `attribute ${key} of node ${this.#nodeId}`,
        );

        let seed: unknown;
        try {
            const { attributes, attributeStatus } = subscription.priming;
            const concrete = concreteKeyOf(path);
            if (concrete === undefined) {
                seed = entriesOf(attributes);
            } else {
                throwIfRefused(attributeStatus, concrete, "subscribe");
                const entry = attributes.get(concrete);
                if (entry === undefined) {
                    throw new MatterServerReadError(
                        `matterjs-server's priming report for subscription ${subscription.id} has neither a value ` +
                            `nor a status for ${concrete}; the server can leave out a cluster that did not change, ` +
                            "because it filters a subscribe by the data versions it holds",
                    );
                }
                seed = valueOf(entry, concrete);
            }
        } catch (error) {
            await subscription.close();
            throw error;
        }

        subscription.listen(report => {
            for (const [reported, entry] of report.attributes) {
                deliverReported(() => valueOf(entry, reported), opts.onUpdate);
            }
        });
        return seed;
    }

    async readEvents(paths: EventPathSpec[], options?: ReadEventOptions): Promise<EventReadEntry[]> {
        if (paths.length === 0) {
            throw new ImplementationError("readEvents requires at least one path");
        }
        paths.forEach(assertExpressible);

        const result = await this.#command("read", {
            node_id: this.#nodeId,
            event_paths: paths.map(path => ({ path: eventKeyOf(path) })),
            ...eventFilterOf(options),
        });
        const { events, eventStatus } = decodeInteractionReport(result);
        throwIfAnyRefused(eventStatus, paths.map(concreteEventKeyOf), "readEvents");
        return events.map(eventEntryOf);
    }

    /** Keeps other subscriptions to the node, as {@link subscribe} does. */
    async subscribeEvents(paths: EventPathSpec[], opts: SubscribeEventOptions): Promise<EventReadEntry[]> {
        if (paths.length === 0) {
            throw new ImplementationError("subscribeEvents requires at least one path");
        }
        paths.forEach(assertExpressible);

        const keys = paths.map(eventKeyOf);
        const subscription = await this.#subscriptions().open(
            {
                node_id: this.#nodeId,
                event_paths: keys.map(path => ({ path, is_urgent: opts.urgent })),
                ...eventFilterOf(opts),
                min_interval: opts.minIntervalFloorSeconds,
                max_interval: opts.maxIntervalCeilingSeconds,
                keep_subscriptions: true,
            },
            `events ${keys.join(", ")} of node ${this.#nodeId}`,
        );

        let seed: EventReadEntry[];
        try {
            const { events, eventStatus } = subscription.priming;
            throwIfAnyRefused(eventStatus, paths.map(concreteEventKeyOf), "subscribeEvents");
            seed = events.map(eventEntryOf);
        } catch (error) {
            await subscription.close();
            throw error;
        }

        subscription.listen(report => {
            for (const event of report.events) {
                deliverReported(() => eventEntryOf(event), opts.onUpdate);
            }
        });
        return seed;
    }

    async observeEvents(): Promise<never> {
        throw refusal("sustained-subscription", "observeEvents");
    }

    async clientEndpoints(): Promise<ClientEndpointEntry[]> {
        const attributes = await this.#heldAttributes();
        const endpoints = new Set<number>();
        for (const key of Object.keys(attributes)) {
            const match = /^(\d+)\//.exec(key);
            if (match !== null) {
                endpoints.add(Number(match[1]));
            }
        }

        return [...endpoints]
            .sort((a, b) => a - b)
            .map(endpoint => ({
                endpoint,
                deviceTypes: listAt(attributes, `${endpoint}/${DESCRIPTOR}/${DEVICE_TYPE_LIST}`).map(deviceTypeOf),
                parts: listAt(attributes, `${endpoint}/${DESCRIPTOR}/${PARTS_LIST}`).map(Number),
            }));
    }

    async clientAttribute(path: ClientAttributePath): Promise<unknown> {
        const attributes = await this.#heldAttributes();
        return heldValue(attributes, pathKeyOf(path));
    }

    async sessions(): Promise<never> {
        throw new UnsupportedByControllerError(
            "the sessions the controller holds with a node",
            CONTROLLER,
            "the WebSocket API exposes no session state",
        );
    }

    async severTransportConnection(): Promise<never> {
        throw new UnsupportedByControllerError(
            "severing the connection beneath a session",
            CONTROLLER,
            "the WebSocket API exposes no session a case could reach into",
        );
    }

    icdClient(): never {
        throw refusal("icd-client", "icdClient");
    }

    async serveOtaUpdate(): Promise<never> {
        throw refusal("ota-provider", "serveOtaUpdate");
    }

    async announceOtaProvider(): Promise<never> {
        throw refusal("ota-provider", "announceOtaProvider");
    }

    async scriptOtaProvider(): Promise<never> {
        throw refusal("ota-provider", "scriptOtaProvider");
    }

    async openCommissioningWindow(opts: {
        timeout: number;
        enhanced: boolean;
    }): Promise<{ manualPairingCode?: string; qrPairingCode?: string }> {
        if (!opts.enhanced) {
            throw new UnsupportedByControllerError(
                "opening a basic commissioning window",
                CONTROLLER,
                "open_commissioning_window ignores its option and always opens an enhanced window",
            );
        }

        const result = await this.#command("open_commissioning_window", {
            node_id: this.#nodeId,
            timeout: opts.timeout,
        });
        if (
            !isObject(result) ||
            typeof result.setup_manual_code !== "string" ||
            typeof result.setup_qr_code !== "string"
        ) {
            throw new UnexpectedDataError(
                `matterjs-server answered open_commissioning_window without pairing codes: ${Diagnostic.json(result)}`,
            );
        }
        return { manualPairingCode: result.setup_manual_code, qrPairingCode: result.setup_qr_code };
    }

    /** Relies on `remove_node` sending RemoveFabric, which the server does whenever it runs without its own subscriptions. */
    async decommission(): Promise<void> {
        await this.#command("remove_node", { node_id: this.#nodeId });
    }

    async operationalMdnsInstanceName(): Promise<string> {
        const compressedFabricId = GlobalFabricId(BigInt(this.#client().serverInfo.compressed_fabric_id));
        return getOperationalDeviceQname(compressedFabricId, this.#nodeId);
    }

    async #readAttributes(paths: AttributePathSpec[], options?: ReadAttributeOptions) {
        if (options?.dataVersions) {
            throw refusal("data-versions", "a read that reports data versions");
        }
        if (options?.largeMessage) {
            throw refusal("tcp-transport", "a read that requires a session permitting large payloads");
        }
        paths.forEach(assertExpressible);

        const result = await this.#command("read", {
            node_id: this.#nodeId,
            attribute_paths: paths.map(pathKeyOf),
            fabric_filtered: options?.fabricFiltered ?? true,
        });
        return decodeInteractionReport(result);
    }

    async #heldAttributes() {
        const node = await this.#command("get_node", { node_id: this.#nodeId });
        if (!isObject(node) || !isObject(node.attributes)) {
            throw new UnexpectedDataError(
                `matterjs-server answered get_node without attributes: ${Diagnostic.json(node)}`,
            );
        }
        return node.attributes;
    }
}

/** The server's `"endpoint/cluster/attribute"` path, `*` for an absent segment. */
function pathKeyOf({ endpoint, cluster, attribute }: AttributePathSpec) {
    return `${endpoint ?? "*"}/${cluster ?? "*"}/${attribute ?? "*"}`;
}

function concreteKeyOf(path: AttributePathSpec) {
    const { endpoint, cluster, attribute } = path;
    return endpoint === undefined || cluster === undefined || attribute === undefined ? undefined : pathKeyOf(path);
}

/** The server's `"endpoint/cluster/event"` path, `*` for an absent segment. */
function eventKeyOf({ endpoint, cluster, event }: EventPathSpec) {
    return `${endpoint ?? "*"}/${cluster ?? "*"}/${event ?? "*"}`;
}

function concreteEventKeyOf(path: EventPathSpec) {
    const { endpoint, cluster, event } = path;
    return endpoint === undefined || cluster === undefined || event === undefined ? undefined : eventKeyOf(path);
}

function assertExpressible(path: { endpoint?: number; cluster?: number; attribute?: number; event?: number }) {
    if (
        path.endpoint === WILDCARD_ENDPOINT ||
        path.cluster === WILDCARD_CLUSTER ||
        path.attribute === WILDCARD_LEAF ||
        path.event === WILDCARD_LEAF
    ) {
        throw new UnsupportedByControllerError(
            `addressing ${JSON.stringify(path)}`,
            CONTROLLER,
            "the server reads this concrete id as a wildcard",
        );
    }
}

/**
 * A field left `undefined` is not sent, so without a `minEventNumber` the request carries no event filter at all, and
 * an event path without `urgent` no IsUrgent flag.
 */
function eventFilterOf(options?: ReadEventOptions) {
    return { fabric_filtered: options?.fabricFiltered ?? true, event_min: options?.minEventNumber };
}

/**
 * A concrete path the device answered with a status fails as in-process. A wildcard path's statuses are per-item
 * results of its expansion, so those are not looked at.
 */
function throwIfRefused(statuses: Map<string, WirePathStatus>, key: string, operation: string) {
    const refused = statuses.get(key);
    if (refused !== undefined) {
        throw new StatusResponseError(`${operation} ${key} failed`, refused.status, refused.clusterStatus);
    }
}

function throwIfAnyRefused(statuses: Map<string, WirePathStatus>, keys: (string | undefined)[], operation: string) {
    for (const key of keys) {
        if (key !== undefined) {
            throwIfRefused(statuses, key, operation);
        }
    }
}

function eventEntryOf({ endpoint, cluster, event, eventNumber, result }: WireEvent): EventReadEntry {
    return { endpoint, cluster, event, eventNumber, value: valueOf(result, `${endpoint}/${cluster}/${event}`) };
}

/**
 * A value of a report after the priming report has no caller to fail, so one without an in-process equivalent is
 * logged and left out.
 */
function deliverReported<T>(decode: () => T, deliver?: (value: T) => void) {
    let value: T;
    try {
        value = decode();
    } catch (error) {
        if (!(error instanceof UnexpectedDataError) && !(error instanceof UnsupportedByControllerError)) {
            throw error;
        }
        logger.warn("Left a value of a matterjs-server subscription report out:", error);
        return;
    }
    deliver?.(value);
}

/**
 * A value the server sent for a path outside its model has nothing an in-process read would return to compare with,
 * which is a gap of this controller rather than a fault of the device.
 */
function valueOf(entry: WireValueResult, key: string) {
    if (entry.kind === "value") {
        return entry.value;
    }
    if (entry.error instanceof MatterServerUnmodeledError) {
        throw refusal("unmodeled-data", `reporting ${key}`);
    }
    throw entry.error;
}

function decodeManualPairingCode(code: string) {
    return refusalOf(() => ManualPairingCodeCodec.decode(code), `manual pairing code ${code}`);
}

/**
 * The entries an in-process wildcard read returns, without the data version the WebSocket API does not carry.
 *
 * A value that does not decode fails the whole read: an in-process read would have returned it, so leaving it out
 * would answer a step with less than the device reported.
 */
function entriesOf(values: Map<string, WireValueResult>): AttributeReadEntry[] {
    const entries = new Array<AttributeReadEntry>();
    for (const [key, entry] of values) {
        const value = valueOf(entry, key);
        const [endpoint, cluster, attribute] = key.split("/").map(Number);
        entries.push({ endpoint, cluster, attribute, value });
    }
    return entries;
}

function heldValue(attributes: Record<string, unknown>, key: string): unknown {
    if (!Object.hasOwn(attributes, key)) {
        return undefined;
    }
    const entry = decodeAttributeResult({ [key]: attributes[key] }).get(key);
    if (entry === undefined) {
        throw new UnexpectedDataError(`Decoding matterjs-server's held value for ${key} produced no result`);
    }
    return valueOf(entry, key);
}

function deviceTypeOf(entry: unknown): number {
    if (!isObject(entry) || typeof entry.deviceType !== "number") {
        throw new UnexpectedDataError(
            `matterjs-server holds a device type entry without a device type: ${Diagnostic.json(entry)}`,
        );
    }
    return entry.deviceType;
}

function listAt(attributes: Record<string, unknown>, key: string): unknown[] {
    const value = heldValue(attributes, key);
    return Array.isArray(value) ? value : [];
}

/** The one status `write_attribute` answers for its one path. */
function writeStatusOf(result: unknown): number {
    if (Array.isArray(result) && result.length === 1) {
        const [entry] = result;
        if (isObject(entry) && typeof entry.Status === "number") {
            return entry.Status;
        }
    }
    throw new UnexpectedDataError(`matterjs-server answered write_attribute with ${Diagnostic.json(result)}`);
}
