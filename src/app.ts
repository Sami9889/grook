import { AwsEventV2, AwsResponse } from "@slack/bolt/dist/receivers/AwsLambdaReceiver.js";
import { invoke } from "./ai.js";
import { app, botId, init, receiver } from "./core.js";
import { AIMessage, BaseMessage, HumanMessage } from "langchain";
import { env } from "cloudflare:workers";
import { client } from "./core.js";
import { GenericMessageEvent } from "@slack/web-api";
import { MessageElement } from "@slack/web-api/dist/types/response/ConversationsHistoryResponse.js";

async function start() {
    const ALLOWED_CHANNELS = new Set(env.ALLOWED_CHANNELS.split(","))
    await init();

    //console.log("Starting");

    app.use(async function(args) {
        args.logger.debug(args.body);
        return args.next();
    })

    app.message(async function(data) {
        const message = data.message;
        const say = data.say;
        if (!(message.channel.startsWith("D") || ALLOWED_CHANNELS.has(message.channel))) {
            console.log("Bad channel:", message.channel);
            if (message.subtype) return;
            await client.chat.postEphemeral({
                channel: message.channel,
                user: (message as GenericMessageEvent).user,
                text: `Ask <@${env.CREATOR_ID}> if you want Grook in this channel.`,
            });
            await client.conversations.leave({
                channel: message.channel
            });
            return;
        }
        console.log(message);
        async function getReplies() {
            let ts = message.ts;
            if ("thread_ts" in message && message.thread_ts) {
                ts = message.thread_ts;
            }
            const repliesData = await client.conversations.replies({
                ts,
                channel: message.channel
            });
            return repliesData.messages ?? [];
        }

        let thread_ts: string | undefined = message.ts;
        switch (message.subtype) {
            case undefined:
                break;
            case "channel_join":
                thread_ts = undefined;
                break;
            default:
                console.log(`Ignoring ${message.subtype}`);
                return;
        }
        if ("bot_id" in message) {
            console.log("Ignoring bot message");
            return;
        }
        const messages: BaseMessage[] = [];
        const replies = await getReplies();
        if (replies.at(-1).user == botId) {
            console.log("Canceled");
            return;
        }
        for (const reply of replies) {
            if (reply.user == botId) {
                messages.push(new AIMessage(reply.text ?? ""));
            } else {
                messages.push(new HumanMessage(
                    `User ID ${reply.user}: ${reply.text}`
                ));
            }
        }
        if (message.subtype) {
            console.log(`Responding to ${message.subtype}`);
        }
        const text = await invoke(messages, {
            channel: message.channel
        });
        console.log("AI response:", text);
        const newReplies = await getReplies();
        if (!text || replies.at(-1).ts != newReplies.at(-1).ts) {
            console.log("Canceled");
            return;
        }
        for (const line of text.split("\n")) {
            if (!line) continue;
            console.log("Sending message:", line);
            await say({
                channel: message.channel,
                thread_ts,
                text: line,
            });
        }
    });
}

async function requestToAws(request: Request): Promise<AwsEventV2> {
    const url = new URL(request.url);
    return {
        version: "2.0",
        routeKey: "$default",
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers: Object.fromEntries(request.headers.entries()),
        requestContext: { http: { method: request.method, path: url.pathname } },
        body: await request.text() || undefined,
        isBase64Encoded: false,
    };
}

async function awsToResponse(response: AwsResponse): Promise<Response> {
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers ?? {})) {
        headers.set(key, value.toString());
    }
    return new Response(response.body, {
        headers,
        status: response.statusCode,
    })
}

export default {
    async fetch(request: Request, env: Record<string, any>, _ctx: any) {
        const url = new URL(request.url);
        console.log(request.method, url.pathname);
        await start();
        const handler = await receiver.start();
        return awsToResponse(await handler(await requestToAws(request), {}, () => {}));
    }
};